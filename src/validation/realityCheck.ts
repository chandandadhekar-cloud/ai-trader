// White's (2000) Reality Check and Hansen's (2005) SPA test for data snooping
// across a strategy family, using the Politis–Romano stationary bootstrap.
// Null: no strategy beats the benchmark (differentials have mean <= 0).

import { mean, seededRandom, std } from './statsUtil.ts';

/** Stationary bootstrap indices with mean block length 1/p. */
export function stationaryBootstrapIndices(T: number, p: number, rand: () => number): number[] {
  const idx = new Array<number>(T);
  idx[0] = Math.floor(rand() * T);
  for (let t = 1; t < T; t++) idx[t] = rand() < p ? Math.floor(rand() * T) : (idx[t - 1] + 1) % T;
  return idx;
}

export interface RcResult {
  statistic: number;
  pRealityCheck: number;
  pSpa: number;
  bestIndex: number;
  B: number;
}

/**
 * @param diffs T x K matrix of performance differentials (strategy return minus
 *        benchmark return) for K strategies.
 */
export function realityCheck(diffs: number[][], B = 1000, meanBlock = 10, seed = 7): RcResult {
  const T = diffs.length;
  const K = diffs[0]?.length ?? 0;
  if (T < 20 || K < 1) throw new Error('reality check needs T >= 20 and K >= 1');
  const cols = Array.from({ length: K }, (_, k) => diffs.map((r) => r[k]));
  const means = cols.map(mean);
  const sds = cols.map((c) => std(c) || 1e-12);
  const sqT = Math.sqrt(T);
  const V = Math.max(...means.map((m) => sqT * m));
  const Vs = Math.max(...means.map((m, k) => (sqT * m) / sds[k]));
  const bestIndex = means.indexOf(Math.max(...means));
  // Hansen's recentering: drop clearly-bad strategies from the null (consistent SPA).
  const thresh = means.map((_, k) => -sds[k] * Math.sqrt((2 * Math.log(Math.log(T))) / T));
  const muC = means.map((m, k) => (m >= thresh[k] ? m : 0));
  const rand = seededRandom(seed);
  let cntRc = 0;
  let cntSpa = 0;
  for (let b = 0; b < B; b++) {
    const idx = stationaryBootstrapIndices(T, 1 / meanBlock, rand);
    let vb = -Infinity;
    let vsb = -Infinity;
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (const i of idx) s += cols[k][i];
      const mb = s / T;
      vb = Math.max(vb, sqT * (mb - means[k]));
      vsb = Math.max(vsb, (sqT * (mb - muC[k])) / sds[k]);
    }
    if (vb >= V) cntRc++;
    if (vsb >= Vs) cntSpa++;
  }
  return { statistic: V, pRealityCheck: cntRc / B, pSpa: cntSpa / B, bestIndex, B };
}
