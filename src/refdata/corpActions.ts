// Corporate actions (plan §P1.7). Raw bars are never overwritten; adjustment
// factors are stored separately and applied on read (backward adjustment: prices
// before the ex-date are multiplied by the cumulative factor).

import type { Bar } from '../core/types.ts';

export type CorpActionType = 'SPLIT' | 'BONUS' | 'DIVIDEND' | 'RIGHTS';

export interface CorpAction {
  isin: string;
  exDate: string; // YYYY-MM-DD, first date trading ex-entitlement
  type: CorpActionType;
  /** SPLIT: old FV / new FV (e.g. 10→2 gives 5). BONUS: new shares per held share (1:1 → 1). */
  ratio?: number;
  /** DIVIDEND: amount per share. */
  amount?: number;
  /** RIGHTS: rights shares per held share and issue price. */
  rightsRatio?: number;
  rightsPrice?: number;
}

/**
 * Price adjustment factor for an action given the close on the day before ex-date.
 * Multiply pre-ex prices by the factor (volume divides by it for splits/bonus).
 */
export function adjustmentFactor(a: CorpAction, prevClose: number): number {
  switch (a.type) {
    case 'SPLIT':
      return a.ratio && a.ratio > 0 ? 1 / a.ratio : 1;
    case 'BONUS':
      return a.ratio && a.ratio > 0 ? 1 / (1 + a.ratio) : 1;
    case 'DIVIDEND':
      return a.amount && prevClose > a.amount ? (prevClose - a.amount) / prevClose : 1;
    case 'RIGHTS': {
      if (!a.rightsRatio || a.rightsPrice === undefined || prevClose <= 0) return 1;
      // Theoretical ex-rights price.
      const terp = (prevClose + a.rightsRatio * a.rightsPrice) / (1 + a.rightsRatio);
      return terp / prevClose;
    }
  }
}

/** Returns adjusted copies; input bars must be one instrument sorted by ts. */
export function adjustBars(bars: Bar[], actions: CorpAction[], dateOf: (ts: number) => string): Bar[] {
  if (!actions.length) return bars.map((b) => ({ ...b }));
  const sorted = [...actions].sort((a, b) => a.exDate.localeCompare(b.exDate));
  // Cumulative factor for each action applies to bars dated before its ex-date.
  const factors: { exDate: string; f: number; volF: number }[] = [];
  for (const a of sorted) {
    const prev = [...bars].reverse().find((b) => dateOf(b.ts) < a.exDate);
    if (!prev) continue;
    const f = adjustmentFactor(a, prev.close);
    const volF = a.type === 'SPLIT' || a.type === 'BONUS' ? 1 / f : 1;
    factors.push({ exDate: a.exDate, f, volF });
  }
  return bars.map((b) => {
    const d = dateOf(b.ts);
    let f = 1;
    let vf = 1;
    for (const x of factors) if (d < x.exDate) { f *= x.f; vf *= x.volF; }
    return { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f, volume: b.volume * vf };
  });
}
