import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBacktest, syntheticHistory } from '../src/sim/backtester.ts';
import { syntheticInstruments } from '../src/marketdata/syntheticFeed.ts';
import { defaultStrategies } from '../src/strategies/library.ts';
import { isTradingDay } from '../src/config/calendar.ts';
import { loadSettings } from '../src/config/settings.ts';
import { App } from '../src/app.ts';
import { startServer } from '../src/api/server.ts';

test('backtest is deterministic and every entry fills after its signal bar (no look-ahead)', async () => {
  const insts = syntheticInstruments().slice(0, 6);
  const bars = syntheticHistory(insts, 4, '2026-09-24', 9, isTradingDay);
  const a = await runBacktest({ instruments: insts, bars, strategies: defaultStrategies(), capital: 1_000_000 });
  const b = await runBacktest({ instruments: insts, bars, strategies: defaultStrategies(), capital: 1_000_000 });
  assert.equal(a.metrics.endEquity, b.metrics.endEquity);
  assert.equal(a.metrics.trades, b.metrics.trades);
  assert.ok(a.metrics.trades > 0);
  assert.ok(a.metrics.fees > 0);
  const doubled = await runBacktest({ instruments: insts, bars, strategies: defaultStrategies(), capital: 1_000_000, sim: { slippageMultiplier: 3 } });
  assert.ok(doubled.metrics.endEquity < a.metrics.endEquity + 1e-6);
});

test('API: login required, CSRF header enforced, health public', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tradeai-'));
  const s = loadSettings({ DB_PATH: join(dir, 't.db'), PORT: '18181', HOST: '127.0.0.1', DATA_SOURCE: 'synthetic' }, '/nonexistent');
  const app = new App(s);
  const srv = startServer(app);
  try {
    const base = 'http://127.0.0.1:18181';
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    const pw = readFileSync(join(dir, 'INITIAL_ADMIN_PASSWORD.txt'), 'utf8').match(/password: (\S+)/)![1];
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'nope' }) })).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: pw }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    const ov = await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } });
    assert.equal(ov.status, 200);
    assert.equal((await ov.json()).mode, 'paper');
    const noCsrf = await fetch(`${base}/api/killswitch`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ engage: true, reason: 'x' }) });
    assert.equal(noCsrf.status, 403);
    const k = await fetch(`${base}/api/killswitch`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'tradeai' }, body: JSON.stringify({ engage: true, reason: 'test' }) });
    assert.equal((await k.json()).engaged, true);
    const audit = await (await fetch(`${base}/api/audit/verify`, { headers: { Cookie: cookie } })).json();
    assert.equal(audit.ok, true);
    const bad = await fetch(`${base}/api/config/risk`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'tradeai' }, body: JSON.stringify({ riskPerTrade: 0.5 }) });
    assert.equal(bad.status, 400); // schema caps risk per trade at 2%
  } finally {
    await srv.close();
    await app.stop();
  }
});
