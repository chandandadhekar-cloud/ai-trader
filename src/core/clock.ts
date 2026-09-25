// Clock abstraction. Backtests drive a SimClock; live uses the system clock with
// skew tracking against exchange timestamps (plan §15: alert on skew > 50 ms).

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class SimClock implements Clock {
  private t: number;
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    if (t < this.t) throw new Error(`SimClock cannot go backwards: ${t} < ${this.t}`);
    this.t = t;
  }
}

export const IST_OFFSET_MS = 330 * 60 * 1000;

/** Parts of an epoch-ms timestamp in Asia/Kolkata (no DST, fixed +05:30). */
export function istParts(ts: number): { date: string; hh: number; mm: number; ss: number; minuteOfDay: number; dow: number } {
  const d = new Date(ts + IST_OFFSET_MS);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  return {
    date: d.toISOString().slice(0, 10),
    hh,
    mm,
    ss: d.getUTCSeconds(),
    minuteOfDay: hh * 60 + mm,
    dow: d.getUTCDay(),
  };
}

/** Epoch ms for an IST wall-clock time on an IST date (YYYY-MM-DD). */
export function istToEpoch(date: string, hh: number, mm: number, ss = 0): number {
  const [y, mo, da] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, da, hh, mm, ss) - IST_OFFSET_MS;
}

/** IST minute-of-day without Date allocation (hot path). */
export function istMinuteOfDay(ts: number): number {
  const ms = (((ts + IST_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000;
  return Math.floor(ms / 60_000);
}

export function istDate(ts: number): string {
  return istParts(ts).date;
}

/**
 * Tracks the offset between exchange timestamps and local receive time.
 * A robust estimate uses the minimum (latency-floor) over a sliding window:
 * transit latency is always >= 0, so the smallest (recv - exchange) is the best
 * estimate of pure clock skew.
 */
export class SkewMonitor {
  private samples: number[] = [];
  private readonly window: number;
  constructor(window = 500) {
    this.window = window;
  }
  observe(exchangeTs: number, recvTs: number): void {
    if (!exchangeTs) return;
    this.samples.push(recvTs - exchangeTs);
    if (this.samples.length > this.window) this.samples.shift();
  }
  /** Estimated skew in ms (local minus exchange); undefined until samples exist. */
  skewMs(): number | undefined {
    if (this.samples.length < 10) return undefined;
    return Math.min(...this.samples);
  }
  /** Median observed feed latency (includes skew). */
  medianLatencyMs(): number | undefined {
    if (!this.samples.length) return undefined;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
