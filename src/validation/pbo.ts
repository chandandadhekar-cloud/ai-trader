// Probability of Backtest Overfitting via Combinatorially Symmetric Cross-
// Validation (Bailey, Borwein, López de Prado & Zhu 2017). Gate: PBO < 0.2.
//
// Input: a T x N matrix of per-period returns for N strategy configurations over
// the same periods. The rows are split into S equal blocks; for every choice of
// S/2 blocks as in-sample, pick the configuration with the best IS Sharpe and find
// its relative rank out-of-sample. PBO = share of splits where that rank is at or
// below the median (logit <= 0).

import { combinations, sharpe } from './statsUtil.ts';

export interface PboResult {
  pbo: number;
  splits: number;
  logits: number[];
  /** Mean OOS Sharpe of the IS-best config, and the probability it is negative. */
  meanOosSharpeOfBest: number;
  probOosLoss: number;
  /** Slope of OOS vs IS performance of the selected config (degradation). */
  degradationSlope: number;
}

export function pboCscv(matrix: number[][], S = 16): PboResult {
  const T = matrix.length;
  const N = matrix[0]?.length ?? 0;
  if (N < 2) throw new Error('PBO needs at least 2 configurations');
  if (S % 2 !== 0 || S < 2) throw new Error('S must be even');
  const blockLen = Math.floor(T / S);
  if (blockLen < 2) throw new Error(`not enough rows (${T}) for S=${S} blocks`);
  const blocks = Array.from({ length: S }, (_, i) => matrix.slice(i * blockLen, (i + 1) * blockLen));
  const logits: number[] = [];
  const isPerf: number[] = [];
  const oosPerf: number[] = [];
  for (const isIdx of combinations(S, S / 2)) {
    const isSet = new Set(isIdx);
    const isRows = blocks.filter((_, i) => isSet.has(i)).flat();
    const oosRows = blocks.filter((_, i) => !isSet.has(i)).flat();
    const col = (rows: number[][], j: number) => rows.map((r) => r[j]);
    const isSr = Array.from({ length: N }, (_, j) => sharpe(col(isRows, j)));
    const oosSr = Array.from({ length: N }, (_, j) => sharpe(col(oosRows, j)));
    let best = 0;
    for (let j = 1; j < N; j++) if (isSr[j] > isSr[best]) best = j;
    // Relative rank of `best` OOS in (0, 1): (rank) / (N + 1), rank 1 = worst.
    const rank = oosSr.filter((x) => x < oosSr[best]).length + 1 + 0.5 * (oosSr.filter((x) => x === oosSr[best]).length - 1);
    const w = rank / (N + 1);
    logits.push(Math.log(w / (1 - w)));
    isPerf.push(isSr[best]);
    oosPerf.push(oosSr[best]);
  }
  const n = logits.length;
  const mIs = isPerf.reduce((a, b) => a + b, 0) / n;
  const mOos = oosPerf.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vIs = 0;
  for (let i = 0; i < n; i++) {
    cov += (isPerf[i] - mIs) * (oosPerf[i] - mOos);
    vIs += (isPerf[i] - mIs) ** 2;
  }
  return {
    pbo: logits.filter((l) => l <= 0).length / n,
    splits: n,
    logits,
    meanOosSharpeOfBest: mOos,
    probOosLoss: oosPerf.filter((x) => x < 0).length / n,
    degradationSlope: vIs > 0 ? cov / vIs : 0,
  };
}
