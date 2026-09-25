import { memDb, flush } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuoteBook } from '../src/marketdata/quoteBook.ts';
import { InstrumentRegistry } from '../src/refdata/instruments.ts';
import { Portfolio } from '../src/oms/portfolio.ts';
import { PaperBroker } from '../src/brokers/paper.ts';
import { Oms } from '../src/oms/oms.ts';
import { RiskEngine } from '../src/risk/engine.ts';
import { KillSwitch } from '../src/risk/killSwitch.ts';
import { RuntimeConfig } from '../src/config/runtime.ts';
import { TaxLedger } from '../src/analytics/taxLedger.ts';
import type { Instrument, Signal } from '../src/core/types.ts';
import type { Broker } from '../src/brokers/broker.ts';

const inst: Instrument = { key: 'NSE_EQ|T', symbol: 'T', venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: 0.05, series: 'EQ', sector: 'IT' };

function setup(brokerOverride?: (b: PaperBroker) => Broker) {
  const { db, bus, audit } = memDb();
  const quotes = new QuoteBook();
  const ref = new InstrumentRegistry();
  ref.upsert(inst);
  const now = Date.now();
  for (let i = 0; i < 60; i++) quotes.onBar({ key: inst.key, ts: now - (60 - i) * 60_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 200000 });
  quotes.onTick({ key: inst.key, ltp: 100, ltt: now, recvTs: now, bid: 99.95, ask: 100.05, source: 'synthetic' });
  const pf = new Portfolio(db, quotes, ref, 'paper', 1_000_000);
  const paper = new PaperBroker({ quotes, refdata: ref, buildHeaders: () => ({ 'X-Algo-Name': 'test-algo' }), isContinuous: () => true });
  const broker = brokerOverride ? brokerOverride(paper) : paper;
  const oms = new Oms({ broker, db, bus, refdata: ref, quotes, audit, portfolio: pf, mode: 'paper', algoName: 'test-algo' });
  oms.useTimers = false;
  oms.reconciled = true;
  const rc = new RuntimeConfig(db, audit);
  const kill = new KillSwitch(db, bus, audit);
  const risk = new RiskEngine({ portfolio: pf, quotes, kill, refdata: ref, limits: () => rc.get('risk') });
  return { db, bus, audit, quotes, ref, pf, paper, oms, rc, kill, risk };
}
const sig = (o: Partial<Signal> = {}): Signal => ({ strategyId: 'trend_following', instrumentKey: inst.key, side: 'BUY', strength: 0.6, entry: 100, stop: 98, target: 106, timeStopMin: 60, reason: 't', ts: 1_790_000_000_000, ...o });
const okGate = { allowed: true, sizeMultiplier: 1, reasons: [], flags: [] };

test('risk sizing: 0.5% of equity at risk, capped by 1% participation, rounded to lot', () => {
  const { risk } = setup();
  const d = risk.size(sig(), inst, okGate, 1, Date.now(), '2026-09-25');
  assert.equal(d.approved, true);
  // Budget 5,000 / 2 per share = 2,500; participation 1% of 200,000 = 2,000.
  assert.equal(d.qty, 2000);
  const lot = risk.size(sig(), { ...inst, lotSize: 750 }, okGate, 1, Date.now(), '2026-09-25');
  assert.equal(lot.qty % 750, 0);
});

test('risk: kill switch and tradability gate reject; tiny edge vs costs rejects', () => {
  const { risk, kill } = setup();
  assert.equal(risk.size(sig(), inst, { allowed: false, sizeMultiplier: 0, reasons: ['GSM_STAGE_1'], flags: [] }, 1, Date.now(), 'd').approved, false);
  const tiny = risk.size(sig({ stop: 99.9, target: 100.05 }), inst, okGate, 1, Date.now(), 'd');
  assert.equal(tiny.approved, false);
  assert.match(tiny.reasons.join(), /edge too small/);
  kill.engage('test', 'tester');
  assert.match(risk.size(sig(), inst, okGate, 1, Date.now(), 'd').reasons.join(), /kill switch/);
});

test('OMS: entry fills, broker-side stop is placed and acknowledged, headers carry X-Algo-Name', async () => {
  const { oms, pf, paper } = setup();
  const o = await oms.submitEntry(sig(), 100, inst);
  await flush(); await flush();
  assert.equal(o!.type, 'LIMIT');
  const p = pf.get(inst.key, 'trend_following')!;
  assert.equal(p.qty, 100);
  assert.equal(p.stopPrice, 98);
  assert.equal(p.protectiveConfirmed, true);
  const prot = oms.openOrders().find((x) => x.purpose === 'protective')!;
  assert.equal(prot.type, 'SL');
  assert.equal(prot.side, 'SELL');
  assert.equal(prot.qty, 100);
  assert.deepEqual(paper.lastOrderHeaders(), { 'X-Algo-Name': 'test-algo' });
});

test('OMS: the same signal never produces two orders (idempotency)', async () => {
  const { oms } = setup();
  await oms.submitEntry(sig(), 10, inst);
  await oms.submitEntry(sig(), 10, inst);
  await flush();
  assert.equal(oms.stats.duplicateBlocked, 1);
});

test('OMS: failed protective stop flattens the position and raises P0', async () => {
  let alerts = 0;
  const { oms, pf, bus } = setup((paper) => ({
    ...paper, name: 'flaky', live: false,
    placeOrder: (r) => (r.type === 'SL' ? Promise.reject(new Error('stop rejected')) : paper.placeOrder(r)),
    modifyOrder: paper.modifyOrder.bind(paper), cancelOrder: paper.cancelOrder.bind(paper), getOrders: paper.getOrders.bind(paper),
    getPositions: paper.getPositions.bind(paper), onOrderUpdate: paper.onOrderUpdate.bind(paper), onFill: paper.onFill.bind(paper),
  }));
  bus.on('alert', (a) => { if (a.severity === 'P0') alerts++; });
  await oms.submitEntry(sig(), 50, inst);
  for (let i = 0; i < 5; i++) await flush();
  assert.ok(alerts >= 1);
  assert.equal(pf.get(inst.key, 'trend_following')!.qty, 0);
});

test('OMS: stop hit closes the position, cancels leftovers and books tax ledger', async () => {
  const { oms, pf, paper, quotes, db } = setup();
  await oms.submitEntry(sig(), 100, inst);
  await flush(); await flush();
  const t = Date.now();
  quotes.onTick({ key: inst.key, ltp: 97.9, ltt: t, recvTs: t, bid: 97.85, ask: 97.95, source: 'synthetic' });
  paper.onMarket(inst.key);
  await flush(); await flush();
  assert.equal(pf.get(inst.key, 'trend_following')!.qty, 0);
  assert.equal(oms.openOrders().length, 0);
  assert.ok(pf.closedTrades[0].netPnl < 0);
  const rows = new TaxLedger(db).summary(require_fy(), 'paper');
  assert.equal(rows.find((r) => r.bucket === 'EQ_INTRADAY')!.trades, 1);
});

function require_fy(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  const s = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `FY${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}

test('reconciliation detects a position mismatch and blocks until acknowledged', async () => {
  const { oms, paper } = setup();
  paper.seedPositions([{ instrumentKey: inst.key, qty: 25, avgPrice: 100 }]);
  const r = await oms.reconcile();
  assert.equal(r.ok, false);
  assert.deepEqual(r.positionMismatches, [{ instrumentKey: inst.key, local: 0, broker: 25 }]);
  assert.equal(oms.reconciled, false);
  oms.acknowledgeReconcile('tester', 'flattened manually at broker');
  assert.equal(oms.reconciled, true);
});

test('crypto VDA ledger: 30% on each gain, no loss set-off', () => {
  const { db } = memDb();
  const t = new TaxLedger(db);
  const ts = Date.UTC(2026, 5, 1);
  t.record({ ts, bucket: 'CRYPTO_VDA', instrumentKey: 'BTCUSD', qty: 1, buyValue: 100, sellValue: 200, charges: 1, tds: 2, strategyId: 's', mode: 'paper' });
  t.record({ ts, bucket: 'CRYPTO_VDA', instrumentKey: 'BTCUSD', qty: 1, buyValue: 200, sellValue: 100, charges: 1, tds: 1, strategyId: 's', mode: 'paper' });
  const vda = t.summary('FY2026-27', 'paper').find((r) => r.bucket === 'CRYPTO_VDA')!;
  assert.equal(vda.grossPnl, 0);
  assert.ok(Math.abs(vda.estTax - 100 * 0.3 * 1.04) < 1e-9); // tax on the gain despite a net zero
  assert.equal(vda.tdsCredit, 3);
});
