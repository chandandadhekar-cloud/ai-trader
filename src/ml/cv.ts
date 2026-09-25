// Purged K-fold and Combinatorial Purged Cross-Validation (AFML ch. 7 & 12).
// Each sample i spans [t0_i, t1_i] (entry to label resolution). Training samples
// whose span overlaps any test span are purged, and an embargo removes training
// samples that start shortly after a test block (serial-correlation leakage).

import { binom, combinations } from '../validation/statsUtil.ts';

export interface Span {
  t0: number;
  t1: number;
}

export interface Split {
  train: number[];
  test: number[];
  testGroups?: number[];
}

function purge(spans: Span[], testIdx: number[], embargo: number): number[] {
  const test = new Set(testIdx);
  const sorted = [...testIdx].sort((a, b) => a - b);
  // Contiguous runs of test indices → [earliest t0, latest t1 + embargo] time blocks.
  const blocks: { lo: number; hi: number }[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < sorted.length; k++) {
    const i = sorted[k];
    lo = Math.min(lo, spans[i].t0);
    hi = Math.max(hi, spans[i].t1);
    if (k === sorted.length - 1 || sorted[k + 1] !== i + 1) {
      blocks.push({ lo, hi: hi + embargo });
      lo = Infinity;
      hi = -Infinity;
    }
  }
  const train: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    if (test.has(i)) continue;
    const s = spans[i];
    if (blocks.some((b) => s.t0 <= b.hi && s.t1 >= b.lo)) continue;
    train.push(i);
  }
  return train;
}

/** Purged K-fold. `embargo` is in the same time units as spans (e.g. ms). */
export function purgedKFold(spans: Span[], k: number, embargo: number): Split[] {
  const n = spans.length;
  const size = Math.floor(n / k);
  const out: Split[] = [];
  for (let f = 0; f < k; f++) {
    const test = Array.from({ length: f === k - 1 ? n - f * size : size }, (_, i) => f * size + i);
    out.push({ train: purge(spans, test, embargo), test });
  }
  return out;
}

/**
 * CPCV: split into nGroups sequential groups, test on every combination of
 * kTest groups. Produces C(n, k) splits and φ = k/n · C(n, k) backtest paths.
 */
export function cpcv(spans: Span[], nGroups: number, kTest: number, embargo: number): { splits: Split[]; nPaths: number } {
  const n = spans.length;
  const size = Math.floor(n / nGroups);
  const groups = Array.from({ length: nGroups }, (_, g) => Array.from({ length: g === nGroups - 1 ? n - g * size : size }, (_, i) => g * size + i));
  const splits: Split[] = combinations(nGroups, kTest).map((tg) => {
    const test = tg.flatMap((g) => groups[g]);
    return { train: purge(spans, test, embargo), test, testGroups: tg };
  });
  return { splits, nPaths: (kTest / nGroups) * binom(nGroups, kTest) };
}
