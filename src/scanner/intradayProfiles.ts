// Time-of-day profiles (plan §B).
//  - Volatility profile: the U-shaped intraday curve means a 1% move at the open
//    is not the same as 1% at 13:30. Learned cross-sectionally (all symbols) per
//    15-minute bucket as the mean absolute standardized return, normalised so the
//    session average is 1. Starts from a U-shaped prior.
//  - Cumulative-volume profile per symbol: cumulative volume at each 15-minute
//    bucket boundary for the last 20 sessions; RVOL = cumulative volume now /
//    median cumulative volume at the same time of day (linearly interpolated).

import { median } from './stats.ts';

export const BUCKET_MIN = 15;
export const SESSION_MIN = 375;
export const N_BUCKETS = Math.ceil(SESSION_MIN / BUCKET_MIN); // 25

export function bucketOf(minSinceOpen: number): number {
  return Math.min(N_BUCKETS - 1, Math.max(0, Math.floor(minSinceOpen / BUCKET_MIN)));
}

export class VolatilityProfile {
  private sums = new Float64Array(N_BUCKETS);
  private counts = new Float64Array(N_BUCKETS);
  private readonly priorWeight: number;
  private prior: number[];

  constructor(priorWeight = 2000) {
    this.priorWeight = priorWeight;
    // U-shape prior: ~1.8x at the open, ~0.75x midday, ~1.3x into the close.
    this.prior = Array.from({ length: N_BUCKETS }, (_, i) => {
      const x = (i + 0.5) / N_BUCKETS;
      return 0.75 + 1.4 * Math.exp(-x * 9) + 0.55 * Math.exp(-(1 - x) * 7);
    });
    const avg = this.prior.reduce((a, b) => a + b, 0) / N_BUCKETS;
    this.prior = this.prior.map((p) => p / avg);
  }

  /** Feed |r| / sigma_norm observations (dimensionless). */
  observe(minSinceOpen: number, absStdRet: number): void {
    if (!Number.isFinite(absStdRet)) return;
    const b = bucketOf(minSinceOpen);
    this.sums[b] += absStdRet;
    this.counts[b]++;
  }

  /** Multiplier for this time of day (session average ≈ 1). */
  factor(minSinceOpen: number): number {
    const raw = Array.from({ length: N_BUCKETS }, (_, i) => {
      const w = this.priorWeight;
      const emp = this.counts[i] > 0 ? this.sums[i] / this.counts[i] / Math.sqrt(2 / Math.PI) : this.prior[i];
      return (this.prior[i] * w + emp * this.counts[i]) / (w + this.counts[i]);
    });
    const avg = raw.reduce((a, b) => a + b, 0) / N_BUCKETS;
    return raw[bucketOf(minSinceOpen)] / avg;
  }
}

export class VolumeProfile {
  /** days[d][b] = cumulative volume at the end of bucket b on day d. */
  private days: number[][] = [];
  private today: number[] = new Array(N_BUCKETS).fill(NaN);
  private todayDate?: string;
  readonly lookback: number;

  constructor(lookback = 20) {
    this.lookback = lookback;
  }

  /** Update with cumulative volume `cumVol` observed at minSinceOpen on date. */
  observe(date: string, minSinceOpen: number, cumVol: number): void {
    if (this.todayDate && date !== this.todayDate) this.rollDay();
    this.todayDate = date;
    if (minSinceOpen < 0) return;
    const b = bucketOf(minSinceOpen);
    this.today[b] = Math.max(Number.isNaN(this.today[b]) ? 0 : this.today[b], cumVol);
  }

  private rollDay(): void {
    // Forward-fill missing buckets so the curve is monotone.
    let last = 0;
    const filled = this.today.map((v) => (Number.isNaN(v) ? last : (last = v)));
    if (last > 0) this.days.push(filled);
    if (this.days.length > this.lookback) this.days.shift();
    this.today = new Array(N_BUCKETS).fill(NaN);
  }

  /** Seed history (e.g. from stored bars at startup). */
  addDay(curve: number[]): void {
    this.days.push(curve.slice(0, N_BUCKETS));
    if (this.days.length > this.lookback) this.days.shift();
  }

  historyDays(): number {
    return this.days.length;
  }

  /** Median cumulative volume expected by minSinceOpen (interpolated within bucket). */
  expectedCum(minSinceOpen: number): number | undefined {
    if (this.days.length < 5) return undefined;
    const b = bucketOf(minSinceOpen);
    const endB = median(this.days.map((d) => d[b]));
    const startB = b === 0 ? 0 : median(this.days.map((d) => d[b - 1]));
    if (endB === undefined || startB === undefined) return undefined;
    const frac = Math.min(1, Math.max(0, (minSinceOpen - b * BUCKET_MIN) / BUCKET_MIN));
    return startB + (endB - startB) * frac;
  }

  rvol(minSinceOpen: number, cumVol: number): number | undefined {
    const e = this.expectedCum(minSinceOpen);
    return e && e > 0 ? cumVol / e : undefined;
  }
}
