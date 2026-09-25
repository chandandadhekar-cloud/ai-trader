// Holds today's surveillance state and refreshes it from NSE archives.
// If a refresh fails the previous state is kept and the gate reports `stale`,
// which blocks new equity entries (fail closed) until an operator uploads the
// files from the admin console or the download succeeds.

import type { Db } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import { createLogger } from '../core/logger.ts';
import { istDate } from '../core/clock.ts';
import {
  fetchNseFile, nseFileUrls, parseDeals, parseFoSecBan, parseRegInd, parseSecList,
  type Deal, type SurveillanceFlags,
} from './nseFiles.ts';

const log = createLogger('surveillance');

export interface SurveillanceStatus {
  date?: string;
  loadedAt?: number;
  sources: Record<string, { ok: boolean; at?: number; error?: string; count?: number }>;
  counts: { symbols: number; banned: number; gsm: number; asm: number; esm: number; t2t: number };
  fresh: boolean;
}

export class SurveillanceService {
  private flags = new Map<string, SurveillanceFlags>();
  private deals: Deal[] = [];
  private status: SurveillanceStatus = { sources: {}, counts: { symbols: 0, banned: 0, gsm: 0, asm: 0, esm: 0, t2t: 0 }, fresh: false };
  private db: Db;
  private bus: EventBus;
  private now: () => number;
  /** Synthetic mode has no NSE files; the gate treats state as fresh. */
  private synthetic: boolean;

  constructor(db: Db, bus: EventBus, now: () => number = Date.now, synthetic = false) {
    this.db = db;
    this.bus = bus;
    this.now = now;
    this.synthetic = synthetic;
    this.loadFromDb();
  }

  get(symbol: string): SurveillanceFlags | undefined {
    return this.flags.get(symbol);
  }

  /** Fresh = loaded for today's IST date (or synthetic mode). */
  isFresh(): boolean {
    return this.synthetic || this.status.date === istDate(this.now());
  }

  getStatus(): SurveillanceStatus {
    return { ...this.status, fresh: this.isFresh() };
  }

  recentDeals(symbol?: string): Deal[] {
    return symbol ? this.deals.filter((d) => d.symbol === symbol) : this.deals;
  }

  list(filter: 'all' | 'restricted' = 'restricted', limit = 500): SurveillanceFlags[] {
    const out: SurveillanceFlags[] = [];
    for (const f of this.flags.values()) {
      if (filter === 'restricted' && !(f.gsm || f.ltAsm || f.stAsm || f.esm || f.ibc || f.inFnoBan || (f.series && f.series !== 'EQ'))) continue;
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Apply file contents (from download or admin upload). */
  apply(files: { secList?: string; foSecBan?: string; regInd?: string; bulk?: string; block?: string }, source: string): void {
    const date = istDate(this.now());
    const next = new Map<string, SurveillanceFlags>();
    const ensure = (sym: string): SurveillanceFlags => {
      let f = next.get(sym);
      if (!f) next.set(sym, (f = { symbol: sym, gsm: 0, ltAsm: 0, stAsm: 0, esm: 0, ibc: false, inFnoBan: false }));
      return f;
    };
    // Start from the current state so a partial update (e.g. only the ban list) keeps the rest.
    for (const [k, v] of this.flags) next.set(k, { ...v, inFnoBan: files.foSecBan !== undefined ? false : v.inFnoBan });

    const mark = (name: string, fn: () => number) => {
      try {
        const count = fn();
        this.status.sources[name] = { ok: true, at: this.now(), count };
      } catch (e) {
        this.status.sources[name] = { ok: false, at: this.now(), error: String((e as Error).message ?? e) };
        log.error('surveillance parse failed', { name, err: String(e) });
        throw e;
      }
    };

    if (files.secList !== undefined) mark('sec_list', () => {
      const m = parseSecList(files.secList!);
      for (const [sym, v] of m) { const f = ensure(sym); f.series = v.series; f.bandPct = v.bandPct; }
      return m.size;
    });
    if (files.regInd !== undefined) mark('reg_ind', () => {
      const m = parseRegInd(files.regInd!);
      for (const [sym, v] of m) { const f = ensure(sym); Object.assign(f, { ...v, series: v.series ?? f.series }); }
      return m.size;
    });
    if (files.foSecBan !== undefined) mark('fo_secban', () => {
      const { symbols } = parseFoSecBan(files.foSecBan!);
      for (const s of symbols) ensure(s).inFnoBan = true;
      return symbols.size;
    });
    const deals: Deal[] = [];
    if (files.bulk !== undefined) mark('bulk', () => { const d = parseDeals(files.bulk!, 'bulk'); deals.push(...d); return d.length; });
    if (files.block !== undefined) mark('block', () => { const d = parseDeals(files.block!, 'block'); deals.push(...d); return d.length; });
    if (deals.length) this.deals = deals;

    this.flags = next;
    this.status.date = date;
    this.status.loadedAt = this.now();
    this.recount();
    this.persist(date);
    this.bus.publish('system', { kind: 'surveillance.loaded', message: `Surveillance state loaded (${source})`, data: this.status.counts });
  }

  async refreshFromNse(): Promise<void> {
    const urls = nseFileUrls(new Date(this.now() + 330 * 60000));
    const got: Record<string, string> = {};
    const errors: string[] = [];
    await Promise.all(
      (Object.entries(urls) as [keyof typeof urls, string][]).map(async ([k, url]) => {
        try {
          got[k] = await fetchNseFile(url);
        } catch (e) {
          errors.push(`${k}: ${String((e as Error).message ?? e)}`);
          this.status.sources[k] = { ok: false, at: this.now(), error: String((e as Error).message ?? e) };
        }
      }),
    );
    if (Object.keys(got).length) {
      try {
        this.apply(got, 'nse-download');
      } catch {
        /* per-file status already recorded */
      }
    }
    if (errors.length) {
      this.bus.publish('alert', { severity: 'P1', title: 'Surveillance download incomplete', message: errors.join('; '), ts: this.now() });
    }
  }

  private recount(): void {
    const c = { symbols: this.flags.size, banned: 0, gsm: 0, asm: 0, esm: 0, t2t: 0 };
    for (const f of this.flags.values()) {
      if (f.inFnoBan) c.banned++;
      if (f.gsm) c.gsm++;
      if (f.ltAsm || f.stAsm) c.asm++;
      if (f.esm) c.esm++;
      if (f.series && ['BE', 'BZ', 'BT'].includes(f.series)) c.t2t++;
    }
    this.status.counts = c;
  }

  private persist(date: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM surveillance WHERE date = ?', date);
      for (const f of this.flags.values()) {
        const { raw: _raw, ...rest } = f;
        this.db.run('INSERT INTO surveillance (date, symbol, flags) VALUES (?,?,?)', date, f.symbol, JSON.stringify(rest));
      }
    });
    this.db.run(
      'INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      'surveillance_status', JSON.stringify(this.status), this.now(), 'system',
    );
  }

  private loadFromDb(): void {
    const st = this.db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'surveillance_status'");
    if (!st) return;
    this.status = JSON.parse(st.value);
    if (!this.status.date) return;
    for (const r of this.db.all<{ flags: string }>('SELECT flags FROM surveillance WHERE date = ?', this.status.date)) {
      const f = JSON.parse(r.flags) as SurveillanceFlags;
      this.flags.set(f.symbol, f);
    }
  }
}
