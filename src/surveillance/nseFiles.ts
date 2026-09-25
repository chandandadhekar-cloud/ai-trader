// NSE surveillance / tradability files (plan §P0.2). All are downloaded daily
// before the open and applied as hard gates before any signal runs.
//
// Parsers are header-driven and tolerant: NSE occasionally renames columns, and a
// silently mis-parsed ban list is far worse than a loud failure, so each parser
// throws if it cannot locate its required columns.

import { createLogger } from '../core/logger.ts';

const log = createLogger('nse-files');

export interface SurveillanceFlags {
  symbol: string;
  series?: string;
  /** Graded Surveillance Measure stage 0–6 (0 = not in GSM). */
  gsm: number;
  /** Long-term ASM stage 0–4. */
  ltAsm: number;
  /** Short-term ASM stage 0–2. */
  stAsm: number;
  esm: number;
  ibc: boolean;
  /** Price band in percent (2/5/10/20), undefined = no band (F&O / dynamic). */
  bandPct?: number;
  inFnoBan: boolean;
  /** Raw indicator columns for display. */
  raw?: Record<string, string>;
}

/** RFC-4180-ish CSV parser (handles quotes, embedded commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
  return rows;
}

function findCol(header: string[], ...patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = header.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

function stage(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/\d+/);
  if (m) return Number(m[0]);
  return /^(y|yes|true)$/i.test(v.trim()) ? 1 : 0;
}

/** sec_list.csv: Symbol, Series, Security Name, Band, Remarks. */
export function parseSecList(text: string): Map<string, { series: string; bandPct?: number }> {
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.toUpperCase());
  const iSym = findCol(header, /^SYMBOL$/);
  const iSer = findCol(header, /^SERIES$/);
  const iBand = findCol(header, /^BAND$/, /BAND/);
  if (iSym < 0 || iBand < 0) throw new Error(`sec_list.csv: unexpected header ${header.join('|')}`);
  const out = new Map<string, { series: string; bandPct?: number }>();
  for (const r of rows.slice(1)) {
    const band = Number(r[iBand]);
    // Keep EQ over other series for the same symbol; trading series matters for T2T.
    const series = iSer >= 0 ? r[iSer] : 'EQ';
    const prev = out.get(r[iSym]);
    if (prev && prev.series === 'EQ') continue;
    out.set(r[iSym], { series, bandPct: Number.isFinite(band) && band > 0 ? band : undefined });
  }
  return out;
}

/**
 * fo_secban.csv. First line is a title ("Securities in Ban For Trade Date DD-MON-YYYY:"),
 * then "n,SYMBOL" rows. An empty list is valid (no bans).
 */
export function parseFoSecBan(text: string): { tradeDate?: string; symbols: Set<string> } {
  const rows = parseCsv(text);
  const symbols = new Set<string>();
  let tradeDate: string | undefined;
  for (const r of rows) {
    const joined = r.join(',');
    const m = joined.match(/Trade Date\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4})/i);
    if (m) { tradeDate = m[1]; continue; }
    const sym = r.length >= 2 ? r[1] : r[0];
    if (sym && /^[A-Z0-9&\-_.]+$/.test(sym) && !/^\d+$/.test(sym)) symbols.add(sym);
  }
  if (!tradeDate && rows.length > 0 && !/ban/i.test(rows[0].join(','))) {
    log.warn('fo_secban.csv: title line not found; verify file format');
  }
  return { tradeDate, symbols };
}

/** REG_IND indicator file (GSM / LT-ASM / ST-ASM / ESM / IBC columns). */
export function parseRegInd(text: string): Map<string, Omit<SurveillanceFlags, 'inFnoBan' | 'bandPct'>> {
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.toUpperCase().replace(/\s+/g, ' '));
  const iSym = findCol(header, /^SYMBOL$/, /SYMBOL/);
  const iSer = findCol(header, /^SERIES$/);
  const iGsm = findCol(header, /^GSM/, /GRADED/);
  const iLt = findCol(header, /LONG.?TERM/, /LT.?ASM/);
  const iSt = findCol(header, /SHORT.?TERM/, /ST.?ASM/);
  const iEsm = findCol(header, /^ESM/, /ENHANCED/);
  const iIbc = findCol(header, /IBC/, /INSOLVENCY/);
  if (iSym < 0 || (iGsm < 0 && iLt < 0 && iSt < 0)) throw new Error(`REG_IND: unexpected header ${header.join('|')}`);
  const out = new Map<string, Omit<SurveillanceFlags, 'inFnoBan' | 'bandPct'>>();
  for (const r of rows.slice(1)) {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = r[i] ?? ''));
    out.set(r[iSym], {
      symbol: r[iSym],
      series: iSer >= 0 ? r[iSer] : undefined,
      gsm: iGsm >= 0 ? stage(r[iGsm]) : 0,
      ltAsm: iLt >= 0 ? stage(r[iLt]) : 0,
      stAsm: iSt >= 0 ? stage(r[iSt]) : 0,
      esm: iEsm >= 0 ? stage(r[iEsm]) : 0,
      ibc: iIbc >= 0 ? stage(r[iIbc]) > 0 : false,
      raw,
    });
  }
  return out;
}

export interface Deal {
  date: string;
  symbol: string;
  client: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  kind: 'bulk' | 'block';
}

/** bulk.csv / block.csv. */
export function parseDeals(text: string, kind: 'bulk' | 'block'): Deal[] {
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.toUpperCase());
  const iDate = findCol(header, /^DATE$/);
  const iSym = findCol(header, /^SYMBOL$/);
  const iClient = findCol(header, /CLIENT/);
  const iSide = findCol(header, /BUY.?\/.?SELL/, /BUY/);
  const iQty = findCol(header, /QUANTITY/);
  const iPx = findCol(header, /PRICE/);
  if (iSym < 0 || iQty < 0) throw new Error(`${kind}.csv: unexpected header ${header.join('|')}`);
  return rows.slice(1).map((r) => ({
    date: iDate >= 0 ? r[iDate] : '',
    symbol: r[iSym],
    client: iClient >= 0 ? r[iClient] : '',
    side: /S/i.test(r[iSide] ?? '') ? ('SELL' as const) : ('BUY' as const),
    qty: Number(String(r[iQty]).replace(/,/g, '')),
    price: Number(String(r[iPx]).replace(/,/g, '')),
    kind,
  }));
}

export const NSE_ARCHIVE = 'https://nsearchives.nseindia.com';

export function nseFileUrls(date: Date): Record<'secList' | 'foSecBan' | 'bulk' | 'block' | 'regInd', string> {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(2);
  return {
    secList: `${NSE_ARCHIVE}/content/equities/sec_list.csv`,
    foSecBan: `${NSE_ARCHIVE}/content/fo/fo_secban.csv`,
    bulk: `${NSE_ARCHIVE}/content/equities/bulk.csv`,
    block: `${NSE_ARCHIVE}/content/equities/block.csv`,
    regInd: `${NSE_ARCHIVE}/content/equities/REG_IND${dd}${mm}${yy}.csv`,
  };
}

/** Polite fetch for NSE archives (browser UA, timeout, limited retries). */
export async function fetchNseFile(url: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          Accept: 'text/csv,text/plain,*/*',
          Referer: 'https://www.nseindia.com/',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}
