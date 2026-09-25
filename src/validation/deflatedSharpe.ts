// Probabilistic and Deflated Sharpe Ratio (Bailey & López de Prado 2012, 2014).
// DSR corrects the observed Sharpe for the number of trials tried (selection bias)
// and for non-normal returns. Gate: DSR > 0.95 (plan §G).

import { kurtosis, normCdf, normInv, sharpe, skewness } from './statsUtil.ts';

const EULER_GAMMA = 0.5772156649015329;

/**
 * P(true SR > benchmark SR) given T observations with skew g3 and (non-excess)
 * kurtosis g4. All Sharpe ratios are per-period (not annualised).
 */
export function probabilisticSharpe(sr: number, srBenchmark: number, T: number, g3: number, g4: number): number {
  if (T < 2) return 0;
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (denom <= 0) return 0;
  return normCdf(((sr - srBenchmark) * Math.sqrt(T - 1)) / Math.sqrt(denom));
}

/** Expected maximum Sharpe among N independent zero-skill trials with SR variance V. */
export function expectedMaxSharpe(nTrials: number, srVariance: number): number {
  if (nTrials <= 1) return 0;
  return Math.sqrt(srVariance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) + EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E)));
}

export interface DsrResult {
  sharpe: number;
  annualisedSharpe: number;
  sr0: number;
  dsr: number;
  psrZero: number;
  T: number;
  skew: number;
  kurt: number;
  nTrials: number;
}

/**
 * @param returns per-period returns of the selected strategy
 * @param trialSharpes per-period Sharpe ratios of ALL trials tried (from the trial registry)
 * @param periodsPerYear for display (e.g. 252 daily)
 */
export function deflatedSharpe(returns: number[], trialSharpes: number[], periodsPerYear = 252): DsrResult {
  const sr = sharpe(returns);
  const T = returns.length;
  const g3 = skewness(returns);
  const g4 = kurtosis(returns);
  const n = Math.max(1, trialSharpes.length);
  const m = trialSharpes.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? trialSharpes.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) : 0;
  const sr0 = expectedMaxSharpe(n, v);
  return {
    sharpe: sr,
    annualisedSharpe: sr * Math.sqrt(periodsPerYear),
    sr0,
    dsr: probabilisticSharpe(sr, sr0, T, g3, g4),
    psrZero: probabilisticSharpe(sr, 0, T, g3, g4),
    T,
    skew: g3,
    kurt: g4,
    nTrials: n,
  };
}

/** Minimum track record length for PSR(SR*) >= 1 - alpha. */
export function minTrackRecordLength(sr: number, srBenchmark: number, g3: number, g4: number, alpha = 0.05): number {
  if (sr <= srBenchmark) return Infinity;
  const z = normInv(1 - alpha);
  return 1 + (1 - g3 * sr + ((g4 - 1) / 4) * sr * sr) * (z / (sr - srBenchmark)) ** 2;
}
