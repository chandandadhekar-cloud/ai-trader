// Agent control: one clear switch for what the trading agent is allowed to do.
//   running : full operation — scanner, AI research, new entries, exits
//   paused  : no NEW entries; scanner and AI research keep running; open positions
//             stay protected (broker-side stops, targets, time stops, square-off)
//   stopped : no new entries AND no AI research (zero AI spend); scanner keeps
//             logging; open positions stay protected unless flattened on stop
// The state survives restarts. After a switch to live mode the agent always
// starts PAUSED so the first live trade needs an explicit Start.

import type { Db } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import type { AuditLog } from '../governance/auditLog.ts';

export type AgentStatus = 'running' | 'paused' | 'stopped';

export interface AgentState {
  status: AgentStatus;
  since: number;
  by: string;
  reason: string;
}

const KEY = 'agent_state';

export class AgentControl {
  private state: AgentState;
  private db: Db;
  private bus: EventBus;
  private audit: AuditLog;

  constructor(db: Db, bus: EventBus, audit: AuditLog, defaultStatus: AgentStatus = 'running') {
    this.db = db;
    this.bus = bus;
    this.audit = audit;
    const row = db.get<{ value: string }>('SELECT value FROM kv_settings WHERE key = ?', KEY);
    this.state = row ? (JSON.parse(row.value) as AgentState) : { status: defaultStatus, since: Date.now(), by: 'system', reason: 'initial state' };
  }

  get(): AgentState {
    return { ...this.state };
  }

  status(): AgentStatus {
    return this.state.status;
  }

  entriesAllowed(): boolean {
    return this.state.status === 'running';
  }

  researchAllowed(): boolean {
    return this.state.status !== 'stopped';
  }

  set(status: AgentStatus, by: string, reason: string): AgentState {
    const prev = this.state.status;
    this.state = { status, since: Date.now(), by, reason };
    this.db.run(
      'INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
      KEY, JSON.stringify(this.state), Date.now(), by,
    );
    if (prev !== status) {
      this.audit.append(by, `agent.${status}`, null, { from: prev, reason });
      this.bus.publish('system', { kind: 'agent.status', message: `Agent ${status} (${reason}) by ${by}`, data: { from: prev, to: status } });
    }
    return this.get();
  }
}
