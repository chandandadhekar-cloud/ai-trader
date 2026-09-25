// Confidence calibration (plan §C): log every confidence, label outcomes, and fit
// an isotonic (pool-adjacent-violators) map monthly. Until enough outcomes exist
// the map is a conservative shrink toward 0.5 rather than the identity, because
// LLM confidences are typically over-stated.

export interface IsotonicModel {
  xs: number[];
  ys: number[];
  n: number;
  fittedAt: number;
  brierBefore?: number;
  brierAfter?: number;
}

/** Pool-adjacent-violators on (x, y∈{0,1}) pairs; returns block means as a step map. */
export function fitIsotonic(points: { x: number; y: number }[], now = Date.now()): IsotonicModel {
  const pts = [...points].filter((p) => Number.isFinite(p.x)).sort((a, b) => a.x - b.x);
  const blocks: { sum: number; n: number; xMin: number; xMax: number }[] = [];
  for (const p of pts) {
    blocks.push({ sum: p.y, n: 1, xMin: p.x, xMax: p.x });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n, xMin: a.xMin, xMax: b.xMax });
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of blocks) {
    xs.push((b.xMin + b.xMax) / 2);
    ys.push(b.sum / b.n);
  }
  const model: IsotonicModel = { xs, ys, n: pts.length, fittedAt: now };
  model.brierBefore = brier(pts.map((p) => ({ p: p.x, y: p.y })));
  model.brierAfter = brier(pts.map((p) => ({ p: applyIsotonic(model, p.x), y: p.y })));
  return model;
}

export function applyIsotonic(m: IsotonicModel, x: number): number {
  if (!m.xs.length) return x;
  if (x <= m.xs[0]) return m.ys[0];
  if (x >= m.xs[m.xs.length - 1]) return m.ys[m.ys.length - 1];
  for (let i = 1; i < m.xs.length; i++) {
    if (x <= m.xs[i]) {
      const t = (x - m.xs[i - 1]) / (m.xs[i] - m.xs[i - 1]);
      return m.ys[i - 1] + t * (m.ys[i] - m.ys[i - 1]);
    }
  }
  return m.ys[m.ys.length - 1];
}

export function brier(ps: { p: number; y: number }[]): number | undefined {
  if (!ps.length) return undefined;
  return ps.reduce((a, v) => a + (v.p - v.y) ** 2, 0) / ps.length;
}

export const MIN_CALIBRATION_POINTS = 50;

export class Calibrator {
  private model?: IsotonicModel;
  constructor(model?: IsotonicModel) {
    this.model = model;
  }
  set(m: IsotonicModel | undefined): void {
    this.model = m;
  }
  get(): IsotonicModel | undefined {
    return this.model;
  }
  calibrate(conf: number): number {
    const c = Math.min(1, Math.max(0, conf));
    if (this.model && this.model.n >= MIN_CALIBRATION_POINTS) return applyIsotonic(this.model, c);
    return 0.5 + (c - 0.5) * 0.6; // shrink uncalibrated confidence toward 0.5
  }
}
