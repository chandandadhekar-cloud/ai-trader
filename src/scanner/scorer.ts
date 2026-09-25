// Anomaly severity (plan §B "Alert hygiene"): severity = f(|z|, RVOL, residual, liquidity),
// mapped to 0..100. Each component saturates, so one extreme input cannot dominate,
// and illiquid names are discounted (they are the least tradable and the most
// exposed to circuit / surveillance risk).

export interface SeverityInput {
  z?: number;
  rvol?: number;
  residualZ?: number;
  /** Median 1-minute traded value in INR. */
  minuteTurnover?: number;
  bandHit?: boolean;
}

export function severity(i: SeverityInput): number {
  const zc = Math.max(0, Math.abs(i.z ?? 0) - 2) / 4; // |z|=6 → 1
  const vc = i.rvol && i.rvol > 1 ? Math.log(i.rvol) / Math.log(8) : 0; // rvol=8 → 1
  const rc = Math.max(0, Math.abs(i.residualZ ?? 0) - 2) / 4;
  const raw = 0.45 * Math.min(zc, 1.5) + 0.3 * Math.min(vc, 1.5) + 0.25 * Math.min(rc, 1.5) + (i.bandHit ? 0.3 : 0);
  const base = 100 * (1 - Math.exp(-2.2 * raw));
  const liq = i.minuteTurnover === undefined ? 0.8 : Math.min(1, Math.max(0.3, 0.3 + 0.35 * Math.log10(Math.max(i.minuteTurnover, 1) / 1e5)));
  return Math.round(Math.min(100, base * liq) * 10) / 10;
}

export type Buildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';

/** Price-change x OI-change quadrant classification. */
export function buildup(dPrice: number, dOi: number, eps = 0): Buildup {
  if (Math.abs(dPrice) <= eps || Math.abs(dOi) <= eps) return 'NEUTRAL';
  if (dPrice > 0 && dOi > 0) return 'LONG_BUILDUP';
  if (dPrice < 0 && dOi > 0) return 'SHORT_BUILDUP';
  if (dPrice > 0 && dOi < 0) return 'SHORT_COVERING';
  return 'LONG_UNWINDING';
}

/** Order-book imbalance in [-1, 1] (Tier A confirmation only; noisy alone). */
export function imbalance(tbq?: number, tsq?: number): number | undefined {
  if (!tbq || !tsq) return undefined;
  return (tbq - tsq) / (tbq + tsq);
}

export function depthImbalance(depth?: { bidQ: number; askQ: number }[]): number | undefined {
  if (!depth?.length) return undefined;
  const top = depth.slice(0, 5);
  const b = top.reduce((a, d) => a + d.bidQ, 0);
  const s = top.reduce((a, d) => a + d.askQ, 0);
  return b + s > 0 ? (b - s) / (b + s) : undefined;
}
