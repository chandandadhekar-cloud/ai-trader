// Shadow runner and champion–challenger (plan §G.6). Shadow signals are never
// sent to a broker; their outcomes are scored against subsequent bars with the
// signal's own stop / target / time stop (conservative: stop wins a same-bar tie),
// net of estimated round-trip costs. A challenger is promoted only on the
// pre-registered metric (mean R per trade) after at least `minDays` in shadow.

import type { Bar, Signal } from '../core/types.ts';
import type { Db } from '../db/database.ts';
import { mean, std } from '../validation/statsUtil.ts';

interface Pending {
  sig: Signal;
  costR: number;
}

export interface ShadowOutcome {
  strategyId: string;
  instrumentKey: string;
  ts: number;
  r: number;
  exit: 'stop' | 'target' | 'time';
}

export class ShadowTracker {
  private pending: Pending[] = [];
  private outcomes: ShadowOutcome[] = [];
  private db?: Db;

  constructor(db?: Db) {
    this.db = db;
    const row = db?.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'shadow_outcomes'");
    if (row) this.outcomes = JSON.parse(row.value);
  }

  add(sig: Signal, costR = 0.05): void {
    this.pending.push({ sig, costR });
  }

  onBar(b: Bar): void {
    const keep: Pending[] = [];
    for (const p of this.pending) {
      const s = p.sig;
      if (s.instrumentKey !== b.key || b.ts < s.ts) { keep.push(p); continue; }
      const risk = Math.abs(s.entry - s.stop);
      if (risk <= 0) continue;
      const long = s.side === 'BUY';
      const hitStop = long ? b.low <= s.stop : b.high >= s.stop;
      const hitTarget = s.target !== undefined && (long ? b.high >= s.target : b.low <= s.target);
      const timeUp = s.timeStopMin !== undefined && b.ts + 60_000 >= s.ts + s.timeStopMin * 60_000;
      let r: number | undefined;
      let exit: ShadowOutcome['exit'] = 'time';
      if (hitStop) { r = -1; exit = 'stop'; }
      else if (hitTarget) { r = Math.abs(s.target! - s.entry) / risk; exit = 'target'; }
      else if (timeUp) { r = ((b.close - s.entry) * (long ? 1 : -1)) / risk; exit = 'time'; }
      if (r === undefined) { keep.push(p); continue; }
      this.outcomes.push({ strategyId: s.strategyId, instrumentKey: s.instrumentKey, ts: b.ts, r: r - p.costR, exit });
      if (this.outcomes.length > 20_000) this.outcomes.shift();
      this.persist();
    }
    this.pending = keep;
  }

  private persist(): void {
    this.db?.run("INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES ('shadow_outcomes', ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", JSON.stringify(this.outcomes.slice(-5000)), Date.now());
  }

  stats(): Record<string, { n: number; meanR: number; winRate: number; pending: number }> {
    const out: Record<string, { n: number; meanR: number; winRate: number; pending: number }> = {};
    const ids = new Set([...this.outcomes.map((o) => o.strategyId), ...this.pending.map((p) => p.sig.strategyId)]);
    for (const id of ids) {
      const rs = this.outcomes.filter((o) => o.strategyId === id).map((o) => o.r);
      out[id] = { n: rs.length, meanR: rs.length ? mean(rs) : 0, winRate: rs.length ? rs.filter((r) => r > 0).length / rs.length : 0, pending: this.pending.filter((p) => p.sig.strategyId === id).length };
    }
    return out;
  }

  rSeries(strategyId: string): number[] {
    return this.outcomes.filter((o) => o.strategyId === strategyId).map((o) => o.r);
  }

  firstTs(strategyId: string): number | undefined {
    return this.outcomes.find((o) => o.strategyId === strategyId)?.ts;
  }
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  championMeanR: number;
  challengerMeanR: number;
  tStat: number;
}

/** Welch t-test on mean R; promote only if the challenger is better with t > tCrit. */
export function championChallenger(champion: number[], challenger: number[], daysInShadow: number, minDays = 28, minTrades = 30, tCrit = 1.645): PromotionDecision {
  const mc = mean(champion);
  const mx = mean(challenger);
  const se = Math.sqrt((std(champion) ** 2) / Math.max(champion.length, 1) + (std(challenger) ** 2) / Math.max(challenger.length, 1));
  const t = se > 0 ? (mx - mc) / se : 0;
  const base = { championMeanR: mc, challengerMeanR: mx, tStat: t };
  if (daysInShadow < minDays) return { ...base, promote: false, reason: `only ${daysInShadow.toFixed(0)} days in shadow (< ${minDays})` };
  if (challenger.length < minTrades) return { ...base, promote: false, reason: `only ${challenger.length} challenger trades (< ${minTrades})` };
  if (t < tCrit) return { ...base, promote: false, reason: `improvement not significant (t=${t.toFixed(2)} < ${tCrit})` };
  return { ...base, promote: true, reason: `challenger mean R ${mx.toFixed(3)} > champion ${mc.toFixed(3)} (t=${t.toFixed(2)})` };
}
