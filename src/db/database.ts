// SQLite persistence via Node's built-in node:sqlite (no native build step).
// WAL mode + synchronous=NORMAL; schema is plain SQL that ports to Postgres
// (see docs/ARCHITECTURE.md for the Postgres/Timescale upgrade path).

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS kv_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT,
    payload TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  );
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  CREATE TABLE IF NOT EXISTS orders (
    client_order_id TEXT PRIMARY KEY,
    broker_order_id TEXT,
    strategy_id TEXT NOT NULL,
    instrument_key TEXT NOT NULL,
    side TEXT NOT NULL,
    qty INTEGER NOT NULL,
    filled_qty INTEGER NOT NULL DEFAULT 0,
    avg_fill_price REAL,
    order_type TEXT NOT NULL,
    price REAL,
    trigger_price REAL,
    product TEXT NOT NULL,
    validity TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    purpose TEXT NOT NULL DEFAULT 'entry',
    parent_id TEXT,
    mode TEXT NOT NULL,
    algo_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);

  CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_order_id TEXT NOT NULL,
    broker_order_id TEXT,
    instrument_key TEXT NOT NULL,
    side TEXT NOT NULL,
    qty INTEGER NOT NULL,
    price REAL NOT NULL,
    fees REAL NOT NULL,
    ts INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fills_ts ON fills(ts);

  CREATE TABLE IF NOT EXISTS positions (
    instrument_key TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    qty INTEGER NOT NULL,
    avg_price REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    stop_price REAL,
    target_price REAL,
    time_stop_at INTEGER,
    protective_order_id TEXT,
    protective_confirmed INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL,
    PRIMARY KEY (instrument_key, strategy_id, mode)
  );

  CREATE TABLE IF NOT EXISTS anomalies (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    ts INTEGER NOT NULL,
    severity REAL NOT NULL,
    price REAL NOT NULL,
    tier TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0,
    researched INTEGER NOT NULL DEFAULT 0,
    details TEXT NOT NULL,
    fwd_ret_5m REAL,
    fwd_ret_30m REAL,
    fwd_ret_1d REAL
  );
  CREATE INDEX IF NOT EXISTS anomalies_ts ON anomalies(ts);
  CREATE INDEX IF NOT EXISTS anomalies_key ON anomalies(key, ts);

  CREATE TABLE IF NOT EXISTS verdicts (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    symbol TEXT NOT NULL,
    anomaly_id TEXT,
    ts INTEGER NOT NULL,
    path TEXT NOT NULL,
    proposed TEXT NOT NULL,
    final TEXT NOT NULL,
    confidence REAL NOT NULL,
    calibrated_confidence REAL NOT NULL,
    direction TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    cost_usd REAL,
    model TEXT,
    body TEXT NOT NULL,
    outcome_ret REAL,
    outcome_correct INTEGER
  );
  CREATE INDEX IF NOT EXISTS verdicts_ts ON verdicts(ts);

  CREATE TABLE IF NOT EXISTS research_cache (
    cache_key TEXT PRIMARY KEY,
    verdict_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_usage (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    p95_ms INTEGER,
    PRIMARY KEY (day, model)
  );

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    instrument_key TEXT NOT NULL,
    side TEXT NOT NULL,
    strength REAL NOT NULL,
    meta_prob REAL,
    entry REAL NOT NULL,
    stop REAL NOT NULL,
    target REAL,
    decision TEXT NOT NULL,
    reasons TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS signals_ts ON signals(ts);

  CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    params TEXT NOT NULL,
    version TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'champion',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trials (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    hypothesis TEXT,
    params TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    data_range TEXT NOT NULL,
    metrics TEXT NOT NULL,
    sharpe REAL,
    n_obs INTEGER,
    dsr REAL,
    pbo REAL,
    passed INTEGER,
    gate_report TEXT
  );
  CREATE INDEX IF NOT EXISTS trials_strategy ON trials(strategy_id);

  CREATE TABLE IF NOT EXISTS tax_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    fy TEXT NOT NULL,
    bucket TEXT NOT NULL,
    instrument_key TEXT NOT NULL,
    qty INTEGER NOT NULL,
    buy_value REAL NOT NULL,
    sell_value REAL NOT NULL,
    charges REAL NOT NULL,
    gross_pnl REAL NOT NULL,
    tds REAL NOT NULL DEFAULT 0,
    strategy_id TEXT NOT NULL,
    mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS equity_curve (
    ts INTEGER NOT NULL,
    mode TEXT NOT NULL,
    equity REAL NOT NULL,
    cash REAL NOT NULL,
    open_risk REAL NOT NULL,
    gross_exposure REAL NOT NULL,
    PRIMARY KEY (ts, mode)
  );

  CREATE TABLE IF NOT EXISTS surveillance (
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    flags TEXT NOT NULL,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS bars (
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    v REAL NOT NULL,
    oi REAL,
    backfilled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, ts)
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS drift_state (
    strategy_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE positions ADD COLUMN product TEXT NOT NULL DEFAULT 'I';
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
    const current = row?.v ?? 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[i]);
        if (row) this.raw.prepare('UPDATE schema_version SET v = ?').run(i + 1);
        else this.raw.prepare('INSERT INTO schema_version (v) VALUES (?)').run(i + 1);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    }
  }

  prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.prep(sql).run(...params);
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prep(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.prep(sql).all(...params) as T[];
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;
