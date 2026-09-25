// 1-minute bar builder. Volume comes from cumulative `vtt` deltas when the feed
// provides it (Full mode / REST), otherwise from summed last-trade quantities.
// Bars are closed on the first tick of the next minute or by flush(now) from a
// timer, so the last bar of a quiet instrument is not held open indefinitely.

import type { Bar, Tick } from '../core/types.ts';

interface Building {
  bar: Bar;
  lastVtt?: number;
}

export class BarBuilder {
  private building = new Map<string, Building>();
  private lastVtt = new Map<string, number>();
  private lastClose = new Map<string, number>();
  private onBar: (b: Bar) => void;
  readonly intervalMs: number;

  constructor(onBar: (b: Bar) => void, intervalMs = 60_000) {
    this.onBar = onBar;
    this.intervalMs = intervalMs;
  }

  private bucket(ts: number): number {
    return ts - (ts % this.intervalMs);
  }

  onTick(t: Tick): void {
    const ts = t.ltt || t.recvTs;
    const b0 = this.bucket(ts);
    let cur = this.building.get(t.key);
    if (cur && b0 > cur.bar.ts) {
      this.emit(t.key, cur);
      cur = undefined;
    } else if (cur && b0 < cur.bar.ts) {
      return; // late tick for an already-closed minute: ignore (backfill handles gaps)
    }
    let vol = 0;
    if (t.vtt !== undefined) {
      const prev = this.lastVtt.get(t.key);
      if (prev !== undefined && t.vtt >= prev) vol = t.vtt - prev;
      this.lastVtt.set(t.key, t.vtt);
    } else if (t.ltq) {
      vol = t.ltq;
    }
    if (!cur) {
      cur = { bar: { key: t.key, ts: b0, open: t.ltp, high: t.ltp, low: t.ltp, close: t.ltp, volume: vol, oi: t.oi } };
      this.building.set(t.key, cur);
    } else {
      const b = cur.bar;
      b.high = Math.max(b.high, t.ltp);
      b.low = Math.min(b.low, t.ltp);
      b.close = t.ltp;
      b.volume += vol;
      if (t.oi !== undefined) b.oi = t.oi;
    }
  }

  /** Close every bar whose minute has ended (instruments with no ticks produce no bar). */
  flush(now: number): void {
    const cur = this.bucket(now);
    for (const [key, b] of this.building) {
      if (b.bar.ts < cur) {
        this.emit(key, b);
        this.building.delete(key);
      }
    }
  }

  private emit(key: string, b: Building): void {
    this.lastClose.set(key, b.bar.close);
    this.onBar({ ...b.bar });
  }

  current(key: string): Bar | undefined {
    const b = this.building.get(key);
    return b ? { ...b.bar } : undefined;
  }
}
