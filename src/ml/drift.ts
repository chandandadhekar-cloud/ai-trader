// Decay and drift monitoring (plan §P1.13):
//  - PSI and two-sample KS for feature drift
//  - Page–Hinkley and CUSUM alarms on per-trade P&L (expectancy decay)
//  - live-vs-backtest Sharpe confidence interval (demote to shadow when the
//    live CI excludes the backtest estimate)

import { mean, sharpe, std } from '../validation/statsUtil.ts';

/** Population Stability Index with bins from reference deciles. > 0.25 = major shift. */
export function psi(reference: number[], current: number[], bins = 10): number {
  if (reference.length < bins || current.length < bins) return 0;
  const ref = [...reference].sort((a, b) => a - b);
  const edges = Array.from({ length: bins - 1 }, (_, i) => ref[Math.floor(((i + 1) * ref.length) / bins)]);
  const hist = (xs: number[]) => {
    const h = new Array<number>(bins).fill(0);
    for (const x of xs) {
      let b = 0;
      while (b < edges.length && x > edges[b]) b++;
      h[b]++;
    }
    return h.map((c) => Math.max(c / xs.length, 1e-4));
  };
  const r = hist(reference);
  const c = hist(current);
  return r.reduce((a, rv, i) => a + (c[i] - rv) * Math.log(c[i] / rv), 0);
}

/** Two-sample Kolmogorov–Smirnov statistic and asymptotic p-value. */
export function ks2(a: number[], b: number[]): { d: number; p: number } {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const ne = (x.length * y.length) / (x.length + y.length);
  const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k++) p += 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

/** Page–Hinkley test for a downward shift in the mean (e.g. per-trade expectancy). */
export class PageHinkley {
  readonly delta: number;
  readonly lambda: number;
  private n = 0;
  private mean = 0;
  private cum = 0;
  private maxCum = 0;
  alarm = false;
  constructor(delta = 0.005, lambda = 50) {
    this.delta = delta;
    this.lambda = lambda;
  }
  update(x: number): boolean {
    this.n++;
    this.mean += (x - this.mean) / this.n;
    this.cum += x - this.mean + this.delta;
    this.maxCum = Math.max(this.maxCum, this.cum);
    this.alarm = this.maxCum - this.cum > this.lambda;
    return this.alarm;
  }
  state(): { n: number; mean: number; drop: number } {
    return { n: this.n, mean: this.mean, drop: this.maxCum - this.cum };
  }
}

/** Bootstrap CI for the Sharpe ratio of a return series. */
export function sharpeCi(returns: number[], alpha = 0.05, B = 1000, rand: () => number = Math.random): [number, number] {
  if (returns.length < 10) return [-Infinity, Infinity];
  const n = returns.length;
  const s: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: n }, () => returns[Math.floor(rand() * n)]);
    s.push(sharpe(sample));
  }
  s.sort((a, b) => a - b);
  return [s[Math.floor((alpha / 2) * B)], s[Math.floor((1 - alpha / 2) * B) - 1]];
}

export interface DecayCheck {
  liveSharpe: number;
  liveCi: [number, number];
  backtestSharpe: number;
  liveExpectancy: number;
  backtestExpectancy: number;
  demote: boolean;
  reason?: string;
}

/**
 * Demote a strategy to shadow when the live Sharpe CI excludes the backtest estimate,
 * or when live expectancy is below `minFraction` of backtest with enough trades.
 */
export function checkDecay(livePerTrade: number[], backtestSharpe: number, backtestExpectancy: number, minTrades = 30, minFraction = 0.5, rand?: () => number): DecayCheck {
  const liveSharpe = sharpe(livePerTrade);
  const ci = sharpeCi(livePerTrade, 0.05, 1000, rand);
  const liveExp = mean(livePerTrade);
  const base = { liveSharpe, liveCi: ci, backtestSharpe, liveExpectancy: liveExp, backtestExpectancy };
  if (livePerTrade.length < minTrades) return { ...base, demote: false, reason: `only ${livePerTrade.length} live trades` };
  if (ci[1] < backtestSharpe) return { ...base, demote: true, reason: 'live Sharpe CI upper bound below backtest Sharpe' };
  const se = std(livePerTrade) / Math.sqrt(livePerTrade.length);
  if (backtestExpectancy > 0 && liveExp + 1.645 * se < minFraction * backtestExpectancy) {
    return { ...base, demote: true, reason: `live expectancy significantly below ${minFraction * 100}% of backtest` };
  }
  return { ...base, demote: false };
}
