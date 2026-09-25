// Strategy registry: deployment stage per strategy (disabled → shadow → paper →
// live), persisted and audited. Promotion to `live` is only allowed when the
// latest trial for the strategy passed every backtest gate, unless an operator
// explicitly overrides with a written justification (also audited).

import type { Db } from '../db/database.ts';
import type { AuditLog } from '../governance/auditLog.ts';
import type { StrategyStage } from '../core/types.ts';
import type { Strategy } from './base.ts';
import type { TrialRegistry } from '../validation/trialRegistry.ts';

const DEFAULT_STAGE: Record<string, StrategyStage> = {
  trend_following: 'paper',
  mean_reversion: 'paper',
  breakout: 'paper',
  event_driven: 'paper',
  anomaly_fade: 'shadow',
};

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  params: Record<string, number>;
  stage: StrategyStage;
  version: string;
  role: string;
  updatedAt: number;
}

export class StrategyRegistry {
  private db: Db;
  private audit: AuditLog;
  private trials: TrialRegistry;
  readonly strategies: Strategy[];

  constructor(db: Db, audit: AuditLog, trials: TrialRegistry, strategies: Strategy[]) {
    this.db = db;
    this.audit = audit;
    this.trials = trials;
    this.strategies = strategies;
    for (const s of strategies) {
      const row = db.get('SELECT id FROM strategies WHERE id = ?', s.id);
      if (!row) db.run('INSERT INTO strategies (id, stage, params, version, role, updated_at) VALUES (?,?,?,?,?,?)', s.id, DEFAULT_STAGE[s.id] ?? 'shadow', JSON.stringify(s.params), 'v1', 'champion', Date.now());
    }
  }

  stage(id: string): StrategyStage {
    return (this.db.get<{ stage: StrategyStage }>('SELECT stage FROM strategies WHERE id = ?', id)?.stage ?? 'disabled');
  }

  list(): StrategyInfo[] {
    return this.strategies.map((s) => {
      const r = this.db.get<{ stage: StrategyStage; version: string; role: string; updated_at: number }>('SELECT * FROM strategies WHERE id = ?', s.id)!;
      return { id: s.id, name: s.name, description: s.description, params: s.params, stage: r.stage, version: r.version, role: r.role, updatedAt: r.updated_at };
    });
  }

  setStage(id: string, stage: StrategyStage, actor: string, justification?: string): void {
    const s = this.strategies.find((x) => x.id === id);
    if (!s) throw new Error(`unknown strategy ${id}`);
    const prev = this.stage(id);
    if (stage === 'live') {
      const latest = this.trials.list(1, id)[0];
      const gatesOk = latest?.passed === true;
      if (!gatesOk && !(justification && justification.trim().length >= 20)) {
        throw new Error('promotion to live requires the latest trial to pass all backtest gates, or a written override justification (>= 20 chars)');
      }
    }
    this.db.run('UPDATE strategies SET stage = ?, updated_at = ? WHERE id = ?', stage, Date.now(), id);
    this.audit.append(actor, 'strategy.stage', id, { from: prev, to: stage, justification: justification ?? null });
  }
}
