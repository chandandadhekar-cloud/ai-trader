// Ensemble: one decision per instrument per bar. Conflicting sides cancel (no
// trade is the default); agreeing signals merge (strongest levels, combined
// reasons). The meta-label model then vetoes or scales.

import type { Signal } from '../core/types.ts';

export function combineSignals(signals: Signal[]): { accepted: Signal[]; rejected: { signal: Signal; reason: string }[] } {
  const byKey = new Map<string, Signal[]>();
  for (const s of signals) {
    let l = byKey.get(s.instrumentKey);
    if (!l) byKey.set(s.instrumentKey, (l = []));
    l.push(s);
  }
  const accepted: Signal[] = [];
  const rejected: { signal: Signal; reason: string }[] = [];
  for (const [, l] of byKey) {
    const sides = new Set(l.map((s) => s.side));
    if (sides.size > 1) {
      for (const s of l) rejected.push({ signal: s, reason: 'conflicting signals on the same instrument' });
      continue;
    }
    const best = [...l].sort((a, b) => b.strength - a.strength)[0];
    const others = l.filter((s) => s !== best);
    accepted.push({ ...best, strength: Math.min(1, best.strength + 0.1 * others.length), reason: [best.reason, ...others.map((o) => `+${o.strategyId}`)].join('; ') });
    for (const o of others) rejected.push({ signal: o, reason: `merged into ${best.strategyId}` });
  }
  return { accepted, rejected };
}
