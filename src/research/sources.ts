// Research sources. Each document carries BOTH its publication time and the time
// we received it: backtests must use receipt time (plan §E), and the verifier
// rejects causes published after the move began (post-hoc explanations).
//
// Source priority (plan §C): exchange filing > company press release > wire >
// Indian financial media > social. Social-only causes are capped at low confidence.

import type { SyntheticFiling } from '../marketdata/syntheticFeed.ts';
import { createLogger } from '../core/logger.ts';
import { sha256 } from '../core/ids.ts';

const log = createLogger('sources');

export type SourceKind = 'exchange_filing' | 'press_release' | 'wire' | 'media' | 'social';

export const SOURCE_RANK: Record<SourceKind, number> = { exchange_filing: 1, press_release: 2, wire: 3, media: 4, social: 5 };

export interface SourceDoc {
  id: string;
  kind: SourceKind;
  source: string;
  symbol?: string;
  title: string;
  body?: string;
  url?: string;
  publishedTs: number;
  receivedTs: number;
}

export interface NewsSource {
  readonly name: string;
  fetch(symbol: string, sinceTs: number, companyName?: string): Promise<SourceDoc[]>;
}

/** Synthetic filings emitted by the synthetic market (demo mode only). */
export class SyntheticFilingSource implements NewsSource {
  readonly name = 'synthetic-filings';
  private filings: SyntheticFiling[];
  constructor(filings: SyntheticFiling[]) {
    this.filings = filings;
  }
  async fetch(symbol: string, sinceTs: number): Promise<SourceDoc[]> {
    return this.filings
      .filter((f) => f.symbol === symbol && f.ts >= sinceTs)
      .map((f) => ({ id: f.id, kind: 'exchange_filing' as const, source: 'SYNTHETIC', symbol, title: f.title, body: `Synthetic filing for demo purposes. Category: ${f.category}.`, publishedTs: f.ts, receivedTs: f.ts + 2000 }));
  }
}

/**
 * NSE corporate announcements (JSON endpoint behind nseindia.com). NSE requires a
 * browser-like session cookie; we prime it from the home page. Respect rate limits:
 * this is called only from the research path, never in a tight loop.
 */
export class NseAnnouncementsSource implements NewsSource {
  readonly name = 'nse-announcements';
  private cookie = '';
  private cookieAt = 0;
  private async prime(): Promise<void> {
    if (this.cookie && Date.now() - this.cookieAt < 10 * 60_000) return;
    const res = await fetch('https://www.nseindia.com/', { headers: nseHeaders(), signal: AbortSignal.timeout(4000) });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    this.cookieAt = Date.now();
  }
  async fetch(symbol: string, sinceTs: number): Promise<SourceDoc[]> {
    await this.prime();
    const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { headers: { ...nseHeaders(), Cookie: this.cookie }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`NSE announcements HTTP ${res.status}`);
    const rows = (await res.json()) as { desc?: string; attchmntText?: string; attchmntFile?: string; an_dt?: string; sort_date?: string; seq_id?: string }[];
    const now = Date.now();
    return (rows ?? [])
      .map((r) => {
        const ts = parseNseDate(r.sort_date ?? r.an_dt ?? '');
        return {
          id: `NSE-${r.seq_id ?? sha256(`${symbol}${r.desc}${r.an_dt}`).slice(0, 12)}`,
          kind: 'exchange_filing' as const,
          source: 'NSE',
          symbol,
          title: `${symbol}: ${r.desc ?? 'Announcement'}`,
          body: r.attchmntText?.slice(0, 2000),
          url: r.attchmntFile,
          publishedTs: ts ?? now,
          receivedTs: now,
        };
      })
      .filter((d) => d.publishedTs >= sinceTs);
  }
}

/** GDELT DOC 2.0 article list (free; timestamps are crawl times). */
export class GdeltSource implements NewsSource {
  readonly name = 'gdelt';
  async fetch(symbol: string, sinceTs: number, companyName?: string): Promise<SourceDoc[]> {
    const q = encodeURIComponent(`"${companyName ?? symbol}" sourcecountry:IN`);
    const mins = Math.max(15, Math.min(1440, Math.ceil((Date.now() - sinceTs) / 60_000)));
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=25&timespan=${mins}min&sort=datedesc`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { articles?: { url: string; title: string; seendate: string; domain: string }[] };
    const now = Date.now();
    return (j.articles ?? []).map((a) => ({
      id: `GD-${sha256(a.url).slice(0, 12)}`,
      kind: 'media' as const,
      source: a.domain,
      symbol,
      title: a.title,
      url: a.url,
      publishedTs: parseGdeltDate(a.seendate) ?? now,
      receivedTs: now,
    }));
  }
}

/** Generic RSS/Atom feeds (company IR pages, wires, media). */
export class RssSource implements NewsSource {
  readonly name: string;
  private url: string;
  private kind: SourceKind;
  constructor(name: string, url: string, kind: SourceKind) {
    this.name = name;
    this.url = url;
    this.kind = kind;
  }
  async fetch(symbol: string, sinceTs: number, companyName?: string): Promise<SourceDoc[]> {
    const res = await fetch(this.url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`RSS ${this.name} HTTP ${res.status}`);
    const xml = await res.text();
    const now = Date.now();
    const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g)].map((m) => m[0]);
    const needle = new RegExp(`\\b(${escapeRe(symbol)}${companyName ? '|' + escapeRe(companyName) : ''})\\b`, 'i');
    return items
      .map((it) => {
        const title = decode(tag(it, 'title') ?? '');
        const link = tag(it, 'link') ?? it.match(/<link[^>]*href="([^"]+)"/)?.[1];
        const date = tag(it, 'pubDate') ?? tag(it, 'updated') ?? tag(it, 'published');
        return { title, link, ts: date ? Date.parse(date) : NaN, desc: decode(tag(it, 'description') ?? tag(it, 'summary') ?? '') };
      })
      .filter((x) => needle.test(x.title) || needle.test(x.desc))
      .map((x) => ({
        id: `RSS-${sha256(x.link ?? x.title).slice(0, 12)}`,
        kind: this.kind, source: this.name, symbol, title: x.title, body: x.desc.slice(0, 1000), url: x.link,
        publishedTs: Number.isFinite(x.ts) ? x.ts : now, receivedTs: now,
      }))
      .filter((d) => d.publishedTs >= sinceTs);
  }
}

function tag(s: string, name: string): string | undefined {
  const m = s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function decode(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function nseHeaders(): Record<string, string> {
  return { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'application/json,text/html', 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://www.nseindia.com/' };
}
/** "25-Sep-2026 14:05:31" (IST) → epoch ms. */
export function parseNseDate(s: string): number | undefined {
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return undefined;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (mon < 0) return undefined;
  return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +(m[6] ?? 0)) - 330 * 60_000;
}
function parseGdeltDate(s: string): number | undefined {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/** Run sources concurrently with a hard deadline; failures are recorded, not thrown. */
export async function gatherDocs(sources: NewsSource[], symbol: string, sinceTs: number, deadlineMs: number, companyName?: string): Promise<{ docs: SourceDoc[]; errors: string[] }> {
  const errors: string[] = [];
  const results = await Promise.all(
    sources.map((s) =>
      Promise.race([
        s.fetch(symbol, sinceTs, companyName).catch((e) => { errors.push(`${s.name}: ${String((e as Error).message ?? e)}`); return [] as SourceDoc[]; }),
        new Promise<SourceDoc[]>((r) => setTimeout(() => { errors.push(`${s.name}: deadline`); r([]); }, deadlineMs).unref?.()),
      ]),
    ),
  );
  if (errors.length) log.debug('source errors', { symbol, errors });
  return { docs: dedupe(results.flat()), errors };
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
}

/**
 * Near-duplicate removal by token-set Jaccard similarity (>= 0.8), keeping the
 * higher-priority / earlier document. A cheap stand-in for embedding dedup.
 */
export function dedupe(docs: SourceDoc[]): SourceDoc[] {
  const sorted = [...docs].sort((a, b) => SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind] || a.publishedTs - b.publishedTs);
  const kept: { d: SourceDoc; t: Set<string> }[] = [];
  for (const d of sorted) {
    const t = tokens(d.title);
    const dup = kept.some((k) => {
      let inter = 0;
      for (const x of t) if (k.t.has(x)) inter++;
      const union = t.size + k.t.size - inter;
      return union > 0 && inter / union >= 0.8;
    });
    if (!dup && !kept.some((k) => k.d.id === d.id)) kept.push({ d, t });
  }
  return kept.map((k) => k.d);
}
