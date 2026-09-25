// Append-only, hash-chained audit log (plan §16). Each row commits to the previous
// row's hash, so any edit or deletion (the DB also blocks UPDATE/DELETE via
// triggers) is detectable by verify(). Retain for >= 5 years.

import type { Db } from '../db/database.ts';
import { sha256, stableStringify } from '../core/ids.ts';

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  entity: string | null;
  payload: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

export class AuditLog {
  private db: Db;
  private now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  append(actor: string, action: string, entity: string | null, payload: unknown): AuditRow {
    return this.db.tx(() => {
      const last = this.db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
      const prev = last?.hash ?? GENESIS;
      const ts = this.now();
      const body = stableStringify(payload ?? null);
      const hash = sha256(`${prev}|${ts}|${actor}|${action}|${entity ?? ''}|${body}`);
      const r = this.db.run(
        'INSERT INTO audit_log (ts, actor, action, entity, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?)',
        ts, actor, action, entity, body, prev, hash,
      );
      return { id: Number(r.lastInsertRowid), ts, actor, action, entity, payload: body, prev_hash: prev, hash };
    });
  }

  list(opts: { limit?: number; before?: number; action?: string; actor?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.before) { where.push('id < ?'); params.push(opts.before); }
    if (opts.action) { where.push('action LIKE ?'); params.push(`${opts.action}%`); }
    if (opts.actor) { where.push('actor = ?'); params.push(opts.actor); }
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.all<AuditRow>(sql, ...params, Math.min(opts.limit ?? 100, 1000));
  }

  /** Recompute the whole chain. Returns the first broken row id, if any. */
  verify(): { ok: boolean; rows: number; brokenAt?: number } {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.db.prep('SELECT * FROM audit_log ORDER BY id ASC').iterate() as Iterable<AuditRow>) {
      const expect = sha256(`${prev}|${r.ts}|${r.actor}|${r.action}|${r.entity ?? ''}|${r.payload}`);
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, rows: n, brokenAt: r.id };
      prev = r.hash;
      n++;
    }
    return { ok: true, rows: n };
  }
}
