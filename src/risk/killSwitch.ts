// Kill switch: blocks all new entries. Engaged manually from the admin console,
// automatically on drawdown / daily-loss breaches, by the external watchdog, or
// on compliance failure in live mode. Disengaging always requires a human.

import type { Db } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import type { AuditLog } from '../governance/auditLog.ts';

export interface KillState {
  engaged: boolean;
  reason?: string;
  by?: string;
  at?: number;
}

export class KillSwitch {
  private state: KillState = { engaged: false };
  private db: Db;
  private bus: EventBus;
  private audit: AuditLog;

  constructor(db: Db, bus: EventBus, audit: AuditLog) {
    this.db = db;
    this.bus = bus;
    this.audit = audit;
    const r = db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'kill_switch'");
    if (r) this.state = JSON.parse(r.value);
  }

  get(): KillState {
    return { ...this.state };
  }

  engaged(): boolean {
    return this.state.engaged;
  }

  engage(reason: string, by: string): void {
    if (this.state.engaged) return;
    this.state = { engaged: true, reason, by, at: Date.now() };
    this.save();
    this.audit.append(by, 'killswitch.engage', null, { reason });
    this.bus.publish('killswitch', { engaged: true, reason, by, ts: Date.now() });
    this.bus.publish('alert', { severity: 'P0', title: 'Kill switch engaged', message: `${reason} (by ${by})`, ts: Date.now() });
  }

  disengage(by: string, note: string): void {
    if (!this.state.engaged) return;
    const prev = this.state;
    this.state = { engaged: false, by, at: Date.now(), reason: note };
    this.save();
    this.audit.append(by, 'killswitch.disengage', null, { note, previous: prev });
    this.bus.publish('killswitch', { engaged: false, reason: note, by, ts: Date.now() });
  }

  private save(): void {
    this.db.run(
      "INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES ('kill_switch', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
      JSON.stringify(this.state), Date.now(), this.state.by ?? 'system',
    );
  }
}
