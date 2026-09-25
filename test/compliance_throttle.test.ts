import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderThrottle, SlidingWindowLimiter } from '../src/brokers/throttle.ts';
import { ComplianceGuard } from '../src/brokers/compliance.ts';
import { loadSettings } from '../src/config/settings.ts';
import { EventBus } from '../src/core/events.ts';

test('OPS throttle refuses a hard limit at or above the 10 OPS exchange threshold', () => {
  assert.throws(() => new OrderThrottle(10, 5));
});

test('sliding window never admits more than the cap inside the window', () => {
  let t = 0;
  const l = new SlidingWindowLimiter([{ ms: 1000, max: 6 }], () => t);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (l.tryAcquire()) ok++;
  assert.equal(ok, 6);
  t = 999;
  assert.equal(l.tryAcquire(), false);
  t = 1001;
  assert.equal(l.tryAcquire(), true);
});

test('throttle alerts once the alert threshold is reached', async () => {
  let alerted = 0;
  const th = new OrderThrottle(6, 3, Date.now, () => alerted++);
  for (let i = 0; i < 3; i++) await th.acquire();
  assert.equal(alerted, 1);
  assert.equal(th.peakOps, 3);
});

test('compliance: X-Algo-Name header and fail-closed live gate', async () => {
  const bus = new EventBus();
  const s = loadSettings({ MODE: 'live', LIVE_TRADING_ENABLED: 'true', UPSTOX_ALGO_NAME: 'TradeAI-v1', STATIC_IP_PRIMARY: '203.0.113.10' }, '/nonexistent');
  const fakeFetch = (async () => new Response('203.0.113.10')) as typeof fetch;
  const g = new ComplianceGuard(s, bus, () => true, fakeFetch);
  assert.deepEqual(g.orderHeaders(), { 'X-Algo-Name': 'TradeAI-v1' });
  assert.throws(() => g.assertLiveOrderAllowed(), /Egress IP not verified/);
  await g.checkEgressIp();
  assert.doesNotThrow(() => g.assertLiveOrderAllowed());
  const g2 = new ComplianceGuard(s, bus, () => true, (async () => new Response('198.51.100.7')) as typeof fetch);
  await g2.checkEgressIp();
  assert.throws(() => g2.assertLiveOrderAllowed(), /not registered/);
});

test('compliance: missing algo name blocks order headers', () => {
  const s = loadSettings({}, '/nonexistent');
  const g = new ComplianceGuard(s, new EventBus(), () => false);
  assert.throws(() => g.orderHeaders(), /UPSTOX_ALGO_NAME/);
  assert.equal(g.status().liveReady, false);
});
