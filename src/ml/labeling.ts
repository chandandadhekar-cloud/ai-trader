// Triple-barrier labelling (López de Prado, AFML ch. 3) and meta-labels.
// For each event (a primary-strategy signal) at bar i with side s, set a profit
// barrier at +pt·σ, a stop at −sl·σ (σ = volatility estimate at i, in return
// units) and a vertical barrier h bars later. The first barrier touched decides
// the label. Meta-label = 1 if the primary side would have made money.

import type { Bar } from '../core/types.ts';

export interface BarrierEvent {
  index: number; // bar index of entry (enter at the close of bar `index`)
  side: 1 | -1;
  sigma: number; // return-units volatility (e.g. ATR / price)
}

export interface BarrierLabel {
  index: number;
  exitIndex: number;
  side: 1 | -1;
  ret: number; // side-adjusted log return entry → exit
  barrier: 'pt' | 'sl' | 'vertical';
  /** Primary-direction label: +1 / -1 / 0. */
  label: 1 | -1 | 0;
  /** Meta-label: did following the primary side make money? */
  meta: 0 | 1;
  t0: number;
  t1: number;
}

export function tripleBarrier(bars: Bar[], events: BarrierEvent[], pt = 2, sl = 1, h = 30, costReturn = 0): BarrierLabel[] {
  const out: BarrierLabel[] = [];
  for (const e of events) {
    const p0 = bars[e.index]?.close;
    if (!p0 || e.sigma <= 0) continue;
    const up = pt > 0 ? pt * e.sigma : Infinity;
    const dn = sl > 0 ? sl * e.sigma : Infinity;
    const last = Math.min(bars.length - 1, e.index + h);
    let exit = last;
    let barrier: BarrierLabel['barrier'] = 'vertical';
    for (let j = e.index + 1; j <= last; j++) {
      // Use high/low so intrabar touches count; when both touch in one bar assume the stop first (conservative).
      const hiR = e.side * Math.log((e.side === 1 ? bars[j].high : bars[j].low) / p0);
      const loR = e.side * Math.log((e.side === 1 ? bars[j].low : bars[j].high) / p0);
      if (loR <= -dn) { exit = j; barrier = 'sl'; break; }
      if (hiR >= up) { exit = j; barrier = 'pt'; break; }
    }
    let ret: number;
    if (barrier === 'pt') ret = up;
    else if (barrier === 'sl') ret = -dn;
    else ret = e.side * Math.log(bars[exit].close / p0);
    ret -= costReturn;
    const label: 1 | -1 | 0 = barrier === 'pt' ? 1 : barrier === 'sl' ? -1 : ret > 0 ? 1 : ret < 0 ? -1 : 0;
    out.push({ index: e.index, exitIndex: exit, side: e.side, ret, barrier, label, meta: ret > 0 ? 1 : 0, t0: bars[e.index].ts, t1: bars[exit].ts });
  }
  return out;
}

/** Average uniqueness of each label (overlapping labels share information). */
export function averageUniqueness(labels: { index: number; exitIndex: number }[], nBars: number): number[] {
  const conc = new Float64Array(nBars);
  for (const l of labels) for (let j = l.index; j <= l.exitIndex; j++) conc[j]++;
  return labels.map((l) => {
    let s = 0;
    for (let j = l.index; j <= l.exitIndex; j++) s += 1 / conc[j];
    return s / (l.exitIndex - l.index + 1);
  });
}
