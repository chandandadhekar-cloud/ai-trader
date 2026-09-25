// Trial registry (plan §P0.4 / §G): every configuration ever backtested is logged,
// including failures, so the Deflated Sharpe uses the true number of trials. A
// strategy's gate report combines DSR, PBO, costs and stress results.

import type { Db } from '../db/database.ts';
import { newId, sha256, stableStringify } from '../core/ids.ts';

export interface TrialRecord {
  id: string;
  ts: number;
  strategyId: string;
  hypothesis?: string;
  params: Record<string, unknown>;
  dataRange: { from: string; to: string; universe?: string };
  metrics: Record<string, number | string | null>;
  /** Per-period (not annualised) Sharpe. */
  sharpe: number;
  nObs: number;
  dsr?: number;
  pbo?: number;
  passed?: boolean;
  gateReport?: GateReport;
}

export interface GateReport {
  checks: { name: string; passed: boolean; value?: number | string; threshold?: string }[];
  passed: boolean;
}

export class TrialRegistry {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(t: Omit<TrialRecord, 'id' | 'ts'>): TrialRecord {
    const rec: TrialRecord = { ...t, id: newId('T'), ts: Date.now() };
    this.db.run(
      'INSERT INTO trials (id, ts, strategy_id, hypothesis, params, params_hash, data_range, metrics, sharpe, n_obs, dsr, pbo, passed, gate_report) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      rec.id, rec.ts, rec.strategyId, rec.hypothesis ?? null, JSON.stringify(rec.params), sha256(stableStringify(rec.params)),
      JSON.stringify(rec.dataRange), JSON.stringify(rec.metrics), rec.sharpe, rec.nObs, rec.dsr ?? null, rec.pbo ?? null,
      rec.passed === undefined ? null : rec.passed ? 1 : 0, rec.gateReport ? JSON.stringify(rec.gateReport) : null,
    );
    return rec;
  }

  /** Per-period Sharpe of every trial for a strategy family (feeds DSR). */
  trialSharpes(strategyId?: string): number[] {
    const rows = strategyId
      ? this.db.all<{ sharpe: number }>('SELECT sharpe FROM trials WHERE strategy_id = ? AND sharpe IS NOT NULL', strategyId)
      : this.db.all<{ sharpe: number }>('SELECT sharpe FROM trials WHERE sharpe IS NOT NULL');
    return rows.map((r) => r.sharpe);
  }

  count(strategyId?: string): number {
    return strategyId
      ? this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trials WHERE strategy_id = ?', strategyId)!.n
      : this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trials')!.n;
  }

  list(limit = 100, strategyId?: string): TrialRecord[] {
    const rows = strategyId
      ? this.db.all<Record<string, any>>('SELECT * FROM trials WHERE strategy_id = ? ORDER BY ts DESC LIMIT ?', strategyId, limit)
      : this.db.all<Record<string, any>>('SELECT * FROM trials ORDER BY ts DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: r.id, ts: r.ts, strategyId: r.strategy_id, hypothesis: r.hypothesis ?? undefined, params: JSON.parse(r.params),
      dataRange: JSON.parse(r.data_range), metrics: JSON.parse(r.metrics), sharpe: r.sharpe, nObs: r.n_obs,
      dsr: r.dsr ?? undefined, pbo: r.pbo ?? undefined, passed: r.passed === null ? undefined : !!r.passed,
      gateReport: r.gate_report ? JSON.parse(r.gate_report) : undefined,
    }));
  }
}

/** Backtest gates from plan §G. */
export function evaluateGates(x: {
  expectancyAfterCosts: number;
  dsr?: number;
  pbo?: number;
  sharpeDoubledSlippage?: number;
  foldSharpes?: number[];
  regimeSharpes?: Record<string, number>;
}): GateReport {
  const checks: GateReport['checks'] = [
    { name: 'Positive expectancy after full costs and taxes', passed: x.expectancyAfterCosts > 0, value: round(x.expectancyAfterCosts), threshold: '> 0' },
    { name: 'Deflated Sharpe probability', passed: (x.dsr ?? 0) > 0.95, value: x.dsr !== undefined ? round(x.dsr) : 'n/a', threshold: '> 0.95' },
    { name: 'Probability of backtest overfitting', passed: x.pbo !== undefined && x.pbo < 0.2, value: x.pbo !== undefined ? round(x.pbo) : 'n/a', threshold: '< 0.20' },
    { name: 'Survives doubled slippage', passed: (x.sharpeDoubledSlippage ?? -1) > 0, value: x.sharpeDoubledSlippage !== undefined ? round(x.sharpeDoubledSlippage) : 'n/a', threshold: 'Sharpe > 0' },
  ];
  if (x.foldSharpes?.length) {
    const pos = x.foldSharpes.filter((s) => s > 0).length / x.foldSharpes.length;
    checks.push({ name: 'Stable across CPCV folds (share of positive folds)', passed: pos >= 0.7, value: round(pos), threshold: '>= 0.70' });
  }
  if (x.regimeSharpes && Object.keys(x.regimeSharpes).length) {
    const worst = Math.min(...Object.values(x.regimeSharpes));
    checks.push({ name: 'No regime with strongly negative Sharpe', passed: worst > -0.05, value: round(worst), threshold: 'min regime per-period SR > -0.05' });
  }
  return { checks, passed: checks.every((c) => c.passed) };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
