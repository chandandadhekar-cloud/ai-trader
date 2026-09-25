import { gaussian } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateFill, DEFAULT_SIM, type MarketSnapshot } from '../src/sim/fillSimulator.ts';
import { staticBand } from '../src/surveillance/bands.ts';
import { P2Quantile, Welford, Ewma } from '../src/scanner/stats.ts';
import { Cusum, Bocpd } from '../src/scanner/changepoint.ts';
import { VolumeProfile } from '../src/scanner/intradayProfiles.ts';
import { severity, buildup } from '../src/scanner/scorer.ts';
import { TierPromoter } from '../src/scanner/promotion.ts';

const snap = (o: Partial<MarketSnapshot> = {}): MarketSnapshot => ({ ts: 0, ltp: 100, bid: 99.95, ask: 100.05, volume1m: 100000, sigma1m: 0.001, tick: 0.05, continuous: true, ...o });

test('marketable limit buy fills at or below its limit, never above', () => {
  const r = simulateFill({ side: 'BUY', qty: 100, type: 'LIMIT', limit: 100.3, lotSize: 1 }, snap());
  assert.equal(r.fillQty, 100);
  assert.ok(r.fillPrice >= 100.05 && r.fillPrice <= 100.3);
});

test('resting limit needs the price to trade through by a tick', () => {
  const o = { side: 'BUY' as const, qty: 10, type: 'LIMIT' as const, limit: 99, lotSize: 1 };
  assert.equal(simulateFill(o, snap({ ltp: 99.5, bid: 99.45, ask: 99.55, low: 99, high: 99.6 })).fillQty, 0);
  const r = simulateFill(o, snap({ ltp: 99.5, bid: 99.45, ask: 99.55, low: 98.9, high: 99.6 }));
  assert.equal(r.fillQty, 10);
  assert.equal(r.fillPrice, 99);
});

test('participation cap produces partial fills', () => {
  const r = simulateFill({ side: 'BUY', qty: 50000, type: 'LIMIT', limit: 101, lotSize: 1 }, snap({ volume1m: 10000 }));
  assert.equal(r.fillQty, 1000);
});

test('stop-limit triggers on touch; limits outside the band are rejected; locked band gives no fill', () => {
  const stop = simulateFill({ side: 'SELL', qty: 10, type: 'SL', trigger: 98, limit: 97.5, lotSize: 1 }, snap({ ltp: 97.9, bid: 97.85, ask: 97.95, low: 97.8, high: 98.2 }));
  assert.equal(stop.triggered, true);
  assert.equal(stop.fillQty, 10);
  const band = staticBand(100, 5);
  const rej = simulateFill({ side: 'BUY', qty: 1, type: 'LIMIT', limit: 106, lotSize: 1 }, snap({ band }));
  assert.match(rej.rejected!, /outside band/);
  const locked = simulateFill({ side: 'BUY', qty: 1, type: 'LIMIT', limit: 105, lotSize: 1 }, snap({ ltp: 105, bid: 105, ask: 105, low: 105, high: 105, band }));
  assert.equal(locked.fillQty, 0);
  assert.equal(simulateFill({ side: 'BUY', qty: 1, type: 'LIMIT', limit: 101, lotSize: 1 }, snap({ continuous: false })).fillQty, 0);
});

test('doubling the slippage multiplier worsens marketable fills', () => {
  const o = { side: 'BUY' as const, qty: 5000, type: 'LIMIT' as const, limit: 110, lotSize: 1 };
  const a = simulateFill(o, snap(), DEFAULT_SIM).fillPrice;
  const b = simulateFill(o, snap(), { ...DEFAULT_SIM, slippageMultiplier: 2 }).fillPrice;
  assert.ok(b > a);
});

test('P² quantile estimate is close to the true median; Welford/EWMA agree on stationary data', () => {
  const g = gaussian(3);
  const q = new P2Quantile(0.5);
  const w = new Welford();
  const e = new Ewma(0.01);
  for (let i = 0; i < 20000; i++) { const x = g(); q.push(x); w.push(x); e.push(x); }
  assert.ok(Math.abs(q.value()!) < 0.05);
  assert.ok(Math.abs(w.std() - 1) < 0.03);
  assert.ok(Math.abs(e.std() - 1) < 0.2);
});

test('CUSUM detects a mean shift; BOCPD detects a volatility regime change', () => {
  const g = gaussian(5);
  const c = new Cusum(0.5, 6); // same parameters as the scanner
  let fired = 0;
  for (let i = 0; i < 300; i++) if (c.update(g()) !== 0) fired++;
  assert.ok(fired <= 1, `false alarms ${fired}`);
  let det = -1;
  for (let i = 0; i < 50; i++) if (c.update(g() + 1.5) !== 0 && det < 0) det = i;
  assert.ok(det >= 0 && det < 15, `detected at ${det}`);

  const b = new Bocpd(1 / 200, 200);
  let maxBefore = 0;
  for (let i = 0; i < 300; i++) maxBefore = Math.max(maxBefore, b.update(g()));
  let maxAfter = 0;
  for (let i = 0; i < 30; i++) maxAfter = Math.max(maxAfter, b.update(g() * 5));
  assert.ok(maxAfter > 0.5 && maxAfter > maxBefore, `before ${maxBefore} after ${maxAfter}`);
});

test('RVOL compares cumulative volume with the same time of day', () => {
  const vp = new VolumeProfile(20);
  for (let d = 0; d < 6; d++) {
    const curve = Array.from({ length: 25 }, (_, b) => (b + 1) * 1000);
    vp.addDay(curve);
  }
  assert.equal(vp.rvol(15, 1000), 1); // end of bucket 0 → expected 1000
  assert.equal(vp.rvol(22.5, 4500), 3); // midway through bucket 1 → expected 1500
});

test('severity grows with |z|, RVOL and residual and is discounted for illiquid names', () => {
  const lo = severity({ z: 4, rvol: 1, residualZ: 1, minuteTurnover: 1e7 });
  const hi = severity({ z: 7, rvol: 6, residualZ: 5, minuteTurnover: 1e7 });
  const illiquid = severity({ z: 7, rvol: 6, residualZ: 5, minuteTurnover: 1e4 });
  assert.ok(hi > lo && hi <= 100 && illiquid < hi);
  assert.equal(buildup(1, 1), 'LONG_BUILDUP');
  assert.equal(buildup(-1, 1), 'SHORT_BUILDUP');
  assert.equal(buildup(1, -1), 'SHORT_COVERING');
  assert.equal(buildup(-1, -1), 'LONG_UNWINDING');
});

test('tier promotion evicts the least-recently-anomalous unpinned name', () => {
  const p = new TierPromoter(3, ['A', 'B', 'C'], 0);
  p.pin('A');
  p.touch('C', 10);
  const r = p.promote('D', 20);
  assert.equal(r?.evicted, 'B');
  assert.deepEqual(p.keys().sort(), ['A', 'C', 'D']);
});
