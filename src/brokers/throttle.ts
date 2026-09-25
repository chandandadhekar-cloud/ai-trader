// Rate limiting (plan §P0.1).
//  - OrderThrottle: token-bucket OPS guard well under the exchange's 10 orders/sec
//    threshold. Above 10 OPS an algo must be exchange-registered, so the hard cap is
//    enforced here in code, not left to the broker. Alerts fire at `alertAt`.
//  - SlidingWindowLimiter: Upstox general API limits (per sec / per min / per 30 min).

export class SlidingWindowLimiter {
  private readonly windows: { ms: number; max: number; hits: number[] }[];
  private now: () => number;

  constructor(windows: { ms: number; max: number }[], now: () => number = Date.now) {
    this.windows = windows.map((w) => ({ ...w, hits: [] }));
    this.now = now;
  }

  private prune(t: number): void {
    for (const w of this.windows) {
      const cutoff = t - w.ms;
      let i = 0;
      while (i < w.hits.length && w.hits[i] <= cutoff) i++;
      if (i) w.hits.splice(0, i);
    }
  }

  /** ms to wait before a call is allowed (0 = allowed now). */
  waitMs(): number {
    const t = this.now();
    this.prune(t);
    let wait = 0;
    for (const w of this.windows) {
      if (w.hits.length >= w.max) wait = Math.max(wait, w.hits[w.hits.length - w.max] + w.ms - t + 1);
    }
    return wait;
  }

  tryAcquire(): boolean {
    if (this.waitMs() > 0) return false;
    const t = this.now();
    for (const w of this.windows) w.hits.push(t);
    return true;
  }

  async acquire(maxWaitMs = 60_000): Promise<void> {
    const start = this.now();
    for (;;) {
      if (this.tryAcquire()) return;
      const w = this.waitMs();
      if (this.now() - start + w > maxWaitMs) throw new Error(`rate limit: would wait ${w}ms (> ${maxWaitMs}ms budget)`);
      await new Promise((r) => setTimeout(r, Math.min(w, 1000)));
    }
  }

  usage(): { ms: number; max: number; used: number }[] {
    this.prune(this.now());
    return this.windows.map((w) => ({ ms: w.ms, max: w.max, used: w.hits.length }));
  }
}

export class OrderThrottle {
  private readonly limiter: SlidingWindowLimiter;
  readonly hardLimit: number;
  readonly alertAt: number;
  private recent: number[] = [];
  peakOps = 0;
  rejected = 0;
  private onAlert?: (ops: number) => void;
  private lastAlert = 0;
  private now: () => number;

  constructor(hardLimit: number, alertAt: number, now: () => number = Date.now, onAlert?: (ops: number) => void) {
    if (hardLimit >= 10) throw new Error('OPS hard limit must stay below the 10 OPS exchange threshold for unregistered algos');
    this.hardLimit = hardLimit;
    this.alertAt = alertAt;
    this.now = now;
    this.onAlert = onAlert;
    this.limiter = new SlidingWindowLimiter([{ ms: 1000, max: hardLimit }], now);
  }

  currentOps(): number {
    const t = this.now();
    this.recent = this.recent.filter((x) => x > t - 1000);
    return this.recent.length;
  }

  /**
   * Waits for an order slot. Orders never queue longer than `maxWaitMs`; a stale
   * order is worse than no order, so callers get an error instead.
   */
  async acquire(maxWaitMs = 2000): Promise<void> {
    try {
      await this.limiter.acquire(maxWaitMs);
    } catch (e) {
      this.rejected++;
      throw e;
    }
    const t = this.now();
    this.recent.push(t);
    const ops = this.currentOps();
    this.peakOps = Math.max(this.peakOps, ops);
    if (ops >= this.alertAt && t - this.lastAlert > 60_000) {
      this.lastAlert = t;
      this.onAlert?.(ops);
    }
  }
}
