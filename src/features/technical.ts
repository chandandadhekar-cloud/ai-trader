// Streaming and batch technical indicators used by strategies, risk and the scanner.

import type { Bar } from '../core/types.ts';

export function sma(values: number[], n: number): number | undefined {
  if (values.length < n) return undefined;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

export function emaSeries(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e: number | undefined;
  for (const v of values) {
    e = e === undefined ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function trueRange(b: Bar, prevClose?: number): number {
  if (prevClose === undefined) return b.high - b.low;
  return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
}

/** Wilder ATR over the last n bars. */
export function atr(bars: Bar[], n = 14): number | undefined {
  if (bars.length < n + 1) return undefined;
  let a = 0;
  for (let i = 1; i <= n; i++) a += trueRange(bars[i], bars[i - 1].close);
  a /= n;
  for (let i = n + 1; i < bars.length; i++) a = (a * (n - 1) + trueRange(bars[i], bars[i - 1].close)) / n;
  return a;
}

export function rsi(closes: number[], n = 14): number | undefined {
  if (closes.length < n + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Session VWAP from bars (typical price weighting). */
export function vwap(bars: Bar[]): number | undefined {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : undefined;
}

export function highest(values: number[], n: number): number {
  return Math.max(...values.slice(-n));
}
export function lowest(values: number[], n: number): number {
  return Math.min(...values.slice(-n));
}

export function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

/** Efficiency ratio (Kaufman): |net move| / path length, 0..1. Trend vs range regime input. */
export function efficiencyRatio(closes: number[], n: number): number | undefined {
  if (closes.length < n + 1) return undefined;
  const w = closes.slice(-n - 1);
  const net = Math.abs(w[w.length - 1] - w[0]);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path === 0 ? 0 : net / path;
}

/** Rolling OLS beta of y on x. */
export function beta(y: number[], x: number[]): number | undefined {
  const n = Math.min(x.length, y.length);
  if (n < 10) return undefined;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
  }
  return vx === 0 ? undefined : cov / vx;
}

export function correlation(a: number[], b: number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n < 10) return undefined;
  const xs = a.slice(-n);
  const ys = b.slice(-n);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let c = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    c += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx === 0 || vy === 0 ? undefined : c / Math.sqrt(vx * vy);
}
