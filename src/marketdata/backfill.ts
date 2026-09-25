// Gap backfill after WebSocket reconnects (plan §P0 non-negotiables).
// For each affected key we pull today's 1-minute candles and insert any bar the
// live builder missed, flagged `backfilled`. Raw bars are never overwritten.

import type { Bar } from '../core/types.ts';
import type { Db } from '../db/database.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('backfill');

export type CandleRow = [string, number, number, number, number, number, number?];

export function candlesToBars(key: string, rows: CandleRow[]): Bar[] {
  return rows
    .map(([ts, o, h, l, c, v, oi]) => ({ key, ts: Date.parse(ts), open: o, high: h, low: l, close: c, volume: v, oi, backfilled: true }))
    .filter((b) => Number.isFinite(b.ts))
    .sort((a, b) => a.ts - b.ts);
}

/** Minutes in [from, to) with no bar in `have` (1-minute grid). */
export function missingMinutes(have: Set<number>, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from - (from % 60_000); t < to; t += 60_000) if (!have.has(t)) out.push(t);
  return out;
}

export class BackfillService {
  private db: Db;
  private fetchIntraday: (key: string) => Promise<CandleRow[]>;
  private onBar: (b: Bar) => void;
  gapsBackfilled = 0;
  runs = 0;

  constructor(db: Db, fetchIntraday: (key: string) => Promise<CandleRow[]>, onBar: (b: Bar) => void) {
    this.db = db;
    this.fetchIntraday = fetchIntraday;
    this.onBar = onBar;
  }

  saveBar(b: Bar): void {
    this.db.run('INSERT OR IGNORE INTO bars (key, ts, o, h, l, c, v, oi, backfilled) VALUES (?,?,?,?,?,?,?,?,?)', b.key, b.ts, b.open, b.high, b.low, b.close, b.volume, b.oi ?? null, b.backfilled ? 1 : 0);
  }

  async backfill(keys: string[], downSince: number, now = Date.now()): Promise<number> {
    this.runs++;
    let filled = 0;
    for (const key of keys) {
      try {
        const rows = await this.fetchIntraday(key);
        const have = new Set(this.db.all<{ ts: number }>('SELECT ts FROM bars WHERE key = ? AND ts >= ?', key, downSince - 60_000).map((r) => r.ts));
        for (const b of candlesToBars(key, rows)) {
          if (b.ts < downSince - 60_000 || b.ts >= now - 60_000 || have.has(b.ts)) continue;
          this.saveBar(b);
          this.onBar(b);
          filled++;
        }
      } catch (e) {
        log.warn('backfill failed', { key, err: String(e) });
      }
    }
    this.gapsBackfilled += filled;
    return filled;
  }

  /** Share of expected 1-minute bars missing for a key between two times. */
  missingRatio(key: string, from: number, to: number): number {
    const have = new Set(this.db.all<{ ts: number }>('SELECT ts FROM bars WHERE key = ? AND ts >= ? AND ts < ?', key, from, to).map((r) => r.ts));
    const expected = Math.max(1, Math.floor((to - from) / 60_000));
    return missingMinutes(have, from, to).length / expected;
  }
}
