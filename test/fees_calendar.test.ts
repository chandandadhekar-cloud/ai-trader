import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indianCharges, statutoryRatesOn, deltaCharges } from '../src/sim/fees.ts';
import { sessionState, isTradingDay, intradayCutoffs, shiftTradingDay } from '../src/config/calendar.ts';
import { istToEpoch } from '../src/core/clock.ts';

test('STT schedule is effective-dated (Oct 2024 and Apr 2026 changes)', () => {
  assert.equal(statutoryRatesOn('2024-09-30').stt.FUT_SELL, 0.000125);
  assert.equal(statutoryRatesOn('2024-10-01').stt.FUT_SELL, 0.0002);
  assert.equal(statutoryRatesOn('2026-03-31').stt.OPT_SELL_PREMIUM, 0.001);
  assert.equal(statutoryRatesOn('2026-04-01').stt.FUT_SELL, 0.0005);
  assert.equal(statutoryRatesOn('2026-04-01').stt.OPT_SELL_PREMIUM, 0.0015);
});

test('intraday equity round trip: STT on sell only, stamp on buy only, GST on services', () => {
  const buy = indianCharges('EQ_INTRADAY', 'BUY', 100, 1000, '2026-09-25');
  const sell = indianCharges('EQ_INTRADAY', 'SELL', 100.4, 1000, '2026-09-25');
  assert.equal(buy.stt, 0);
  assert.ok(Math.abs(sell.stt - 25.1) < 1e-9); // 0.025% of 1,00,400
  assert.ok(Math.abs(buy.stamp - 3) < 1e-9); // 0.003% of 1,00,000
  assert.equal(sell.stamp, 0);
  assert.equal(buy.brokerage, 20); // min(20, 0.05% x 1L = 50)
  assert.ok(Math.abs(buy.gst - 0.18 * (buy.brokerage + buy.exchange + buy.sebi)) < 1e-9);
  assert.ok(Math.abs(buy.exchange - 2.97) < 1e-9);
});

test('option STT is on premium, exercise STT on intrinsic', () => {
  const s = indianCharges('OPT', 'SELL', 100, 75, '2026-05-01');
  assert.ok(Math.abs(s.stt - 0.0015 * 7500) < 1e-9);
  const ex = indianCharges('OPT', 'SELL', 50, 75, '2026-05-01', undefined, { exercised: true });
  assert.ok(Math.abs(ex.stt - 0.0015 * 3750) < 1e-9);
});

test('Delta fees: taker > maker, 18% GST, TDS only on sells', () => {
  const t = deltaCharges(100000, 'taker', 'BUY');
  const m = deltaCharges(100000, 'maker', 'SELL');
  assert.ok(t.fee > m.fee);
  assert.ok(Math.abs(t.gst - t.fee * 0.18) < 1e-9);
  assert.equal(t.tds, 0);
  assert.equal(m.tds, 1000);
});

test('holidays and weekends are not trading days', () => {
  assert.equal(isTradingDay('2026-10-02'), false); // Gandhi Jayanti
  assert.equal(isTradingDay('2026-09-26'), false); // Saturday
  assert.equal(isTradingDay('2026-09-25'), true);
  assert.equal(shiftTradingDay('2026-10-01', 1), '2026-10-05');
});

test('closing auction session phases for CAS stocks after 3 Aug 2026', () => {
  const d = '2026-09-25';
  assert.equal(sessionState(istToEpoch(d, 15, 10), 'EQ_CAS').phase, 'CONTINUOUS');
  assert.equal(sessionState(istToEpoch(d, 15, 16), 'EQ_CAS').phase, 'CAS_TRANSITION');
  assert.equal(sessionState(istToEpoch(d, 15, 22), 'EQ_CAS').phase, 'CAS_ORDER_ENTRY');
  assert.equal(sessionState(istToEpoch(d, 15, 27), 'EQ_CAS').phase, 'CAS_LIMIT_ONLY');
  assert.equal(sessionState(istToEpoch(d, 15, 55), 'EQ_CAS').phase, 'POST_CLOSE');
  assert.equal(sessionState(istToEpoch(d, 15, 16), 'EQ_CAS').entriesAllowed, false);
  // Non-CAS stocks trade until 15:30; F&O until 15:40.
  assert.equal(sessionState(istToEpoch(d, 15, 25), 'EQ_NON_CAS').phase, 'CONTINUOUS');
  assert.equal(sessionState(istToEpoch(d, 15, 35), 'FO').phase, 'CONTINUOUS');
  assert.equal(sessionState(istToEpoch(d, 15, 41), 'FO').phase, 'CLOSED');
  // Before CAS went live, CAS-class stocks traded continuously to 15:30.
  assert.equal(sessionState(istToEpoch('2026-07-30', 15, 20), 'EQ_CAS').phase, 'CONTINUOUS');
});

test('pre-open schedule changed on 7 Sep 2026', () => {
  assert.equal(sessionState(istToEpoch('2026-09-25', 9, 6), 'EQ_CAS').phase, 'PRE_OPEN_LIMIT_ONLY');
  assert.equal(sessionState(istToEpoch('2026-09-04', 9, 6), 'EQ_CAS').phase, 'PRE_OPEN_ORDER_ENTRY');
});

test('CAS stocks square off before stop orders are auto-cancelled at 15:15', () => {
  const c = intradayCutoffs('2026-09-25', 'EQ_CAS');
  assert.ok(c.squareOff < 15 * 60 + 15);
  assert.ok(c.lastEntry < c.squareOff);
});
