import { memDb } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentControl } from '../src/engine/agentControl.ts';
import { RiskEngine } from '../src/risk/engine.ts';
import { KillSwitch } from '../src/risk/killSwitch.ts';
import { RuntimeConfig, TradingConfigSchema } from '../src/config/runtime.ts';
import { QuoteBook } from '../src/marketdata/quoteBook.ts';
import { InstrumentRegistry } from '../src/refdata/instruments.ts';
import { Portfolio } from '../src/oms/portfolio.ts';
import { usageReport } from '../src/research/llm.ts';
import type { Instrument, Signal } from '../src/core/types.ts';

test('agent control: running/paused/stopped semantics persist and are audited', () => {
  const { db, bus, audit } = memDb();
  const a = new AgentControl(db, bus, audit);
  assert.equal(a.entriesAllowed(), true);
  a.set('paused', 'me', 'lunch');
  assert.equal(a.entriesAllowed(), false);
  assert.equal(a.researchAllowed(), true);
  a.set('stopped', 'me', 'done');
  assert.equal(a.researchAllowed(), false);
  assert.equal(new AgentControl(db, bus, audit).status(), 'stopped'); // survives restart
  assert.equal(audit.list({ action: 'agent.' }).length, 2);
  const { db: db2, bus: b2, audit: a2 } = memDb();
  assert.equal(new AgentControl(db2, b2, a2, 'paused').status(), 'paused'); // live default
});

const btc: Instrument = { key: 'BTCUSD', symbol: 'BTCUSD', venue: 'DELTA', segment: 'DELTA_PERP', type: 'PERP', lotSize: 1, tickSize: 0.5 };
const eq: Instrument = { key: 'NSE_EQ|E', symbol: 'E', venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: 0.05 };

function setup(trading: Record<string, unknown>) {
  const { db, bus, audit } = memDb();
  const quotes = new QuoteBook();
  const ref = new InstrumentRegistry();
  ref.upsert(btc);
  ref.upsert(eq);
  const now = Date.now();
  for (const k of [btc.key, eq.key]) for (let i = 0; i < 40; i++) quotes.onBar({ key: k, ts: now - (40 - i) * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1e9 });
  const pf = new Portfolio(db, quotes, ref, 'paper', 1_000_000);
  const rc = new RuntimeConfig(db, audit);
  rc.update('risk', { maxPositionNotional: 1, maxGrossExposure: 1, maxOpenRisk: 0.2 }, 't');
  rc.update('trading', trading, 't');
  const risk = new RiskEngine({ portfolio: pf, quotes, kill: new KillSwitch(db, bus, audit), refdata: ref, limits: () => rc.get('risk'), trading: () => rc.get('trading') });
  return { risk, rc };
}
const gate = { allowed: true, sizeMultiplier: 1, reasons: [], flags: [] };
const sig = (stopPct: number, o: Partial<Signal> = {}): Signal => ({ strategyId: 's', instrumentKey: btc.key, side: 'BUY', strength: 1, entry: 100, stop: 100 * (1 - stopPct), target: 100 * (1 + stopPct * 10), reason: '', ts: 1, ...o });

test('leverage is off by default and capped per market', () => {
  assert.equal(TradingConfigSchema.parse({}).leverageEnabled, false);
  assert.throws(() => TradingConfigSchema.parse({ equityIntradayLeverage: 6 }));
  const { risk } = setup({ leverageEnabled: true, cryptoLeverage: 25, equityIntradayLeverage: 5 });
  assert.equal(risk.leverageFor(btc), 25);
  assert.equal(risk.leverageFor(eq), 5);
  assert.equal(setup({}).risk.leverageFor(btc), 1);
});

test('risk sizing with 25x: bigger buying power, same loss at the stop', () => {
  const noLev = setup({}).risk.size(sig(0.002), btc, gate, 1, Date.now(), 'd', 1);
  const lev = setup({ leverageEnabled: true, cryptoLeverage: 25 }).risk.size(sig(0.002), btc, gate, 1, Date.now(), 'd', 25);
  assert.ok(lev.approved);
  // 0.5% risk with a 0.2% stop wants ₹25L notional: capped at 1x, allowed at 25x.
  assert.ok(lev.qty > noLev.qty);
  assert.ok(Math.abs(lev.riskAmount - 5000) < 1); // loss at stop = 0.5% of ₹10L
  assert.ok(noLev.riskAmount < lev.riskAmount);
});

test('liquidation guard blocks stops too wide for the leverage', () => {
  const { risk } = setup({ leverageEnabled: true, cryptoLeverage: 25 });
  const d = risk.size(sig(0.02), btc, gate, 1, Date.now(), 'd', 25); // 2% stop vs ~3.5% liquidation
  assert.equal(d.approved, false);
  assert.match(d.reasons.join(), /too wide for 25x/);
});

test('margin sizing commits margin x leverage but never exceeds the hard max loss', () => {
  const { risk } = setup({ leverageEnabled: true, cryptoLeverage: 25, sizingMode: 'margin', marginPerTradePct: 0.1, maxLossPerTradePct: 0.01 });
  const d = risk.size(sig(0.005), btc, gate, 1, Date.now(), 'd', 25);
  // 10% x 25x = ₹25L notional wanted; loss at a 0.5% stop would be ₹12.5k > 1% cap (₹10k).
  assert.ok(d.approved);
  assert.ok(d.riskAmount <= 10_000 + 1);
  assert.match(d.reasons.join(), /max-loss-per-trade cap/);
});

test('usage report aggregates tokens and cost by model, step and day', () => {
  const { db } = memDb();
  const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  db.run("INSERT INTO llm_usage (day, model, calls, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, errors) VALUES (?, 'gpt-6-luna', 3, 3000, 1000, 600, 200, 0.0005, 0)", day);
  db.run("INSERT INTO llm_usage (day, model, calls, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, errors) VALUES (?, 'gpt-6-sol', 1, 5000, 0, 1500, 900, 0.025, 1)", day);
  db.run("INSERT INTO llm_calls (ts, day, model, purpose, run_id, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_usd, latency_ms, ok) VALUES (?, ?, 'gpt-6-sol', 'deep.judge1', 'V1', 5000, 0, 1500, 900, 0.025, 4000, 1)", Date.now(), day);
  const r = usageReport(db, 30);
  assert.equal(r.totals.today.calls, 4);
  assert.ok(Math.abs(r.totals.today.cost_usd - 0.0255) < 1e-9);
  assert.equal(r.byModel[0].model, 'gpt-6-sol');
  assert.equal(r.byPurpose[0].purpose, 'deep.judge1');
  assert.equal(r.pricing['gpt-6-luna'].inputPerM, 0.1);
});
