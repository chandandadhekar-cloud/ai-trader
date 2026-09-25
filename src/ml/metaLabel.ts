// Meta-labeling (plan §P1.12): the deterministic primary strategy decides the
// side; a secondary classifier predicts P(primary signal is right) from context
// features, and that probability vetoes trades or scales size. L2-regularised
// logistic regression with feature standardisation — small, auditable, fast.

import { normCdf } from '../validation/statsUtil.ts';

export const META_FEATURES = [
  'strength', 'sigmaBps', 'efficiencyRatio', 'rvol', 'minuteOfSession', 'rsiDist', 'vwapDistAtr', 'researchConf', 'spreadBps', 'regimeTrend',
] as const;
export type MetaFeatureName = (typeof META_FEATURES)[number];
export type MetaFeatures = Partial<Record<MetaFeatureName, number>>;

export interface MetaModel {
  weights: number[];
  bias: number;
  mu: number[];
  sd: number[];
  trainedAt: number;
  nTrain: number;
  version: string;
}

function vec(f: MetaFeatures, mu?: number[]): number[] {
  // Missing features are imputed with the training mean (→ 0 after standardising).
  return META_FEATURES.map((k, i) => (f[k] !== undefined && Number.isFinite(f[k]!) ? f[k]! : mu ? mu[i] : 0));
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function trainMetaModel(X: MetaFeatures[], y: (0 | 1)[], opts: { l2?: number; epochs?: number; lr?: number; sampleWeights?: number[] } = {}): MetaModel {
  const l2 = opts.l2 ?? 1e-2;
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.1;
  const raw = X.map((f) => vec(f));
  const d = META_FEATURES.length;
  const mu = Array.from({ length: d }, (_, j) => raw.reduce((a, r) => a + r[j], 0) / Math.max(raw.length, 1));
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(raw.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / Math.max(raw.length - 1, 1)) || 1);
  const Z = X.map((f) => vec(f, mu).map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const sw = opts.sampleWeights ?? new Array(Z.length).fill(1);
  const W = sw.reduce((a, v) => a + v, 0) || 1;
  for (let e = 0; e < epochs; e++) {
    const g = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((a, v, j) => a + v * w[j], b));
      const err = (p - y[i]) * sw[i];
      for (let j = 0; j < d; j++) g[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / W + l2 * w[j]);
    b -= lr * (gb / W);
  }
  return { weights: w, bias: b, mu, sd, trainedAt: Date.now(), nTrain: Z.length, version: 'logreg-v1' };
}

export function predictMeta(m: MetaModel, f: MetaFeatures): number {
  const z = vec(f, m.mu).reduce((a, v, j) => a + ((v - m.mu[j]) / m.sd[j]) * m.weights[j], m.bias);
  return sigmoid(z);
}

/**
 * Bet size from probability (AFML ch. 10): z = (p − 0.5)/√(p(1−p)), size = 2Φ(z) − 1,
 * in [0, 1] for p >= 0.5. Discretised to 0.1 steps to avoid churn.
 */
export function betSize(p: number): number {
  if (p <= 0.5) return 0;
  if (p >= 0.999) return 1;
  const z = (p - 0.5) / Math.sqrt(p * (1 - p));
  return Math.round((2 * normCdf(z) - 1) * 10) / 10;
}
