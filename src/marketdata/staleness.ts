// Per-instrument staleness (plan §15). Each instrument's normal tick rate is
// learned (EWMA of inter-arrival gaps); it is stale when the silence exceeds
// `mult` x its normal gap (with a floor), or when exchange time lags local time.
// Stale data blocks entries and tightens exits.

export class StalenessMonitor {
  private last = new Map<string, { recv: number; exch: number; gap: number }>();
  readonly mult: number;
  readonly floorMs: number;
  readonly maxLagMs: number;

  constructor(mult = 10, floorMs = 15_000, maxLagMs = 5_000) {
    this.mult = mult;
    this.floorMs = floorMs;
    this.maxLagMs = maxLagMs;
  }

  observe(key: string, recvTs: number, exchTs: number): void {
    const p = this.last.get(key);
    const gap = p ? 0.9 * p.gap + 0.1 * Math.max(recvTs - p.recv, 1) : 2000;
    this.last.set(key, { recv: recvTs, exch: exchTs || recvTs, gap });
  }

  isStale(key: string, now: number): boolean {
    const p = this.last.get(key);
    if (!p) return true;
    const silence = now - p.recv;
    if (silence > Math.max(this.floorMs, this.mult * p.gap)) return true;
    return p.recv - p.exch > this.maxLagMs;
  }

  lastSeen(key: string): number | undefined {
    return this.last.get(key)?.recv;
  }

  staleKeys(now: number, keys?: Iterable<string>): string[] {
    const out: string[] = [];
    for (const k of keys ?? this.last.keys()) if (this.isStale(k, now)) out.push(k);
    return out;
  }

  /** Median exchange-to-local lag across instruments (tick lag metric). */
  medianLagMs(): number | undefined {
    const lags = [...this.last.values()].map((p) => p.recv - p.exch).sort((a, b) => a - b);
    return lags.length ? lags[Math.floor(lags.length / 2)] : undefined;
  }
}
