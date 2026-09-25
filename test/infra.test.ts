import { memDb } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFeed, encodeFeed } from '../src/brokers/upstox/feed.ts';
import { deltaSignature } from '../src/brokers/delta/rest.ts';
import { mapUpstoxStatus } from '../src/brokers/upstox/rest.ts';
import { quoteToTick } from '../src/marketdata/snapshotSweeper.ts';
import { BarBuilder } from '../src/marketdata/barBuilder.ts';
import { adjustBars } from '../src/refdata/corpActions.ts';
import { EventBus } from '../src/core/events.ts';
import { hashPassword, verifyPassword } from '../src/api/auth.ts';
import type { Bar } from '../src/core/types.ts';

test('audit log is hash-chained and append-only', () => {
  const { db, audit } = memDb();
  audit.append('a', 'x', null, { n: 1 });
  audit.append('b', 'y', 'e', { n: 2 });
  assert.deepEqual(audit.verify(), { ok: true, rows: 2 });
  assert.throws(() => db.raw.exec("UPDATE audit_log SET actor = 'evil'"), /append-only/);
  assert.throws(() => db.raw.exec('DELETE FROM audit_log'), /append-only/);
  // Tampering underneath the triggers is still detected by the chain.
  db.raw.exec('DROP TRIGGER audit_no_update');
  db.raw.exec("UPDATE audit_log SET payload = '{\"n\":9}' WHERE id = 1");
  assert.equal(audit.verify().ok, false);
});

test('Upstox V3 protobuf feed decodes LTPC, Full (depth, vtt, OI) and index frames', () => {
  const buf = encodeFeed({
    type: 1, currentTs: 1790000000123,
    feeds: {
      'NSE_EQ|A': { ltpc: { ltp: 101.5, ltt: 1790000000000, ltq: 10, cp: 100 } },
      'NSE_FO|F': { fullFeed: { marketFF: { ltpc: { ltp: 250, ltt: 1790000000001 }, vtt: 12345, oi: 999, tbq: 10, tsq: 30, marketLevel: { bidAskQuote: [{ bidQ: 5, bidP: 249.9, askQ: 7, askP: 250.1 }] } } } },
      'NSE_INDEX|Nifty 50': { fullFeed: { indexFF: { ltpc: { ltp: 25100, ltt: 1790000000002, cp: 25000 } } } },
    },
  });
  const d = decodeFeed(buf, 1790000000200);
  assert.equal(d.currentTs, 1790000000123);
  const by = Object.fromEntries(d.ticks.map((t) => [t.key, t]));
  assert.equal(by['NSE_EQ|A'].ltp, 101.5);
  assert.equal(by['NSE_EQ|A'].source, 'ws_ltpc');
  assert.equal(by['NSE_FO|F'].vtt, 12345);
  assert.equal(by['NSE_FO|F'].bid, 249.9);
  assert.equal(by['NSE_FO|F'].oi, 999);
  assert.equal(by['NSE_INDEX|Nifty 50'].cp, 25000);
});

test('REST quote → tick and Upstox status mapping', () => {
  const t = quoteToTick({ instrument_token: 'NSE_EQ|A', last_price: 10, volume: 500, net_change: 0.5, ohlc: { open: 9, high: 10, low: 9, close: 9.5 }, depth: { buy: [{ quantity: 1, price: 9.95, orders: 1 }], sell: [{ quantity: 1, price: 10.05, orders: 1 }] } }, 1);
  assert.equal(t!.vtt, 500);
  assert.equal(t!.cp, 9.5);
  assert.equal(mapUpstoxStatus('complete', 10, 10), 'FILLED');
  assert.equal(mapUpstoxStatus('open', 3, 10), 'PARTIALLY_FILLED');
  assert.equal(mapUpstoxStatus('trigger pending', 0, 10), 'NEW');
  assert.equal(mapUpstoxStatus('rejected', 0, 10), 'REJECTED');
});

test('Delta signature is HMAC-SHA256 of method+timestamp+path+query+body', () => {
  const s = deltaSignature('secret', 'POST', '1700000000', '/v2/orders', '', '{"a":1}');
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.notEqual(s, deltaSignature('secret', 'POST', '1700000001', '/v2/orders', '', '{"a":1}'));
});

test('bar builder: cumulative-volume deltas, minute rollover', () => {
  const bars: Bar[] = [];
  const bb = new BarBuilder((b) => bars.push(b));
  const m = 1790000040000 - (1790000040000 % 60000);
  bb.onTick({ key: 'K', ltp: 10, ltt: m + 1000, recvTs: 0, vtt: 100, source: 'ws_full' });
  bb.onTick({ key: 'K', ltp: 11, ltt: m + 2000, recvTs: 0, vtt: 150, source: 'ws_full' });
  bb.onTick({ key: 'K', ltp: 9, ltt: m + 3000, recvTs: 0, vtt: 170, source: 'ws_full' });
  bb.onTick({ key: 'K', ltp: 12, ltt: m + 61000, recvTs: 0, vtt: 200, source: 'ws_full' });
  assert.equal(bars.length, 1);
  assert.deepEqual([bars[0].open, bars[0].high, bars[0].low, bars[0].close, bars[0].volume], [10, 11, 9, 9, 70]);
});

test('corporate actions adjust history without touching raw bars', () => {
  const day = (d: number) => Date.UTC(2026, 0, d, 5);
  const raw: Bar[] = [1, 2, 3].map((d) => ({ key: 'K', ts: day(d), open: 1000, high: 1000, low: 1000, close: 1000, volume: 10 }));
  const adj = adjustBars(raw, [{ isin: 'I', exDate: '2026-01-03', type: 'SPLIT', ratio: 5 }], (ts) => new Date(ts).toISOString().slice(0, 10));
  assert.equal(adj[0].close, 200);
  assert.equal(adj[0].volume, 50);
  assert.equal(adj[2].close, 1000);
  assert.equal(raw[0].close, 1000);
});

test('event bus isolates failing handlers and retains history', () => {
  const bus = new EventBus();
  let got = 0;
  bus.on('alert', () => { throw new Error('boom'); });
  bus.on('alert', () => { got++; });
  bus.publish('alert', { severity: 'INFO', title: 't', message: 'm', ts: 1 });
  assert.equal(got, 1);
  assert.equal(bus.stats().handlerErrors, 1);
  assert.equal(bus.history('alert').length, 1);
});

test('scrypt password hashing', () => {
  const h = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('Upstox order poller turns order-book changes into updates and fill deltas', async () => {
  const { UpstoxClient } = await import('../src/brokers/upstox/rest.ts');
  const { ComplianceGuard } = await import('../src/brokers/compliance.ts');
  const { OrderThrottle } = await import('../src/brokers/throttle.ts');
  const { loadSettings } = await import('../src/config/settings.ts');
  let book: Record<string, unknown>[] = [];
  const fakeFetch = (async () => new Response(JSON.stringify({ status: 'success', data: book }), { status: 200 })) as typeof fetch;
  const s = loadSettings({ UPSTOX_ACCESS_TOKEN: 't', UPSTOX_ALGO_NAME: 'a' }, '/nonexistent');
  const c = new UpstoxClient(s, new ComplianceGuard(s, new EventBus(), () => true), new OrderThrottle(6, 5), fakeFetch);
  const fills: { qty: number; price: number }[] = [];
  const updates: string[] = [];
  c.onFill((f) => fills.push({ qty: f.qty, price: f.price }));
  c.onOrderUpdate((u) => updates.push(u.status));
  const row = (filled: number, avg: number, status: string) => ({ order_id: 'B1', tag: 'TA1', instrument_token: 'NSE_EQ|X', transaction_type: 'BUY', quantity: 100, filled_quantity: filled, average_price: avg, status, order_type: 'LIMIT', price: 101 });
  book = [row(0, 0, 'open')];
  await c.pollOrdersOnce();
  book = [row(40, 100, 'open')];
  await c.pollOrdersOnce();
  book = [row(100, 100.6, 'complete')];
  await c.pollOrdersOnce();
  assert.equal(await c.pollOrdersOnce(), 0); // no change → no event
  assert.deepEqual(updates, ['NEW', 'PARTIALLY_FILLED', 'FILLED']);
  assert.deepEqual(fills, [{ qty: 40, price: 100 }, { qty: 60, price: 101 }]);
});
