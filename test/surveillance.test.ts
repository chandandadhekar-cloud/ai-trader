import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseFoSecBan, parseRegInd, parseSecList } from '../src/surveillance/nseFiles.ts';
import { tradabilityGate } from '../src/surveillance/tradability.ts';
import { DynamicBand, staticBand, bandDistance } from '../src/surveillance/bands.ts';
import { isFreakTrade } from '../src/surveillance/freakTrade.ts';
import type { Instrument } from '../src/core/types.ts';

const eq: Instrument = { key: 'NSE_EQ|X', symbol: 'X', venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: 0.05, series: 'EQ' };
const fut: Instrument = { ...eq, key: 'NSE_FO|XF', type: 'FUT', segment: 'NSE_FO', underlying: 'X', lotSize: 500 };
const clean = { symbol: 'X', gsm: 0, ltAsm: 0, stAsm: 0, esm: 0, ibc: false, inFnoBan: false };

test('CSV parser handles quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\r\n1,"x ""q""",3\r\n'), [['a', 'b,c', 'd'], ['1', 'x "q"', '3']]);
});

test('sec_list, fo_secban and REG_IND parsers', () => {
  const sl = parseSecList('Symbol,Series,Security Name,Band,Remarks\nABC,EQ,Abc Ltd,20,\nXYZ,BE,Xyz Ltd,5,\nFNO,EQ,F Ltd,No Band,');
  assert.equal(sl.get('ABC')!.bandPct, 20);
  assert.equal(sl.get('XYZ')!.series, 'BE');
  assert.equal(sl.get('FNO')!.bandPct, undefined);
  const ban = parseFoSecBan('Securities in Ban For Trade Date 25-SEP-2026:\n1,IDEA\n2,SAIL\n');
  assert.deepEqual([...ban.symbols], ['IDEA', 'SAIL']);
  assert.equal(ban.tradeDate, '25-SEP-2026');
  assert.equal(parseFoSecBan('Securities in Ban For Trade Date 25-SEP-2026: NIL\n').symbols.size, 0);
  const ri = parseRegInd('Symbol,Series,GSM,Long_Term_Additional_Surveillance_Measure (Long Term ASM),Short Term ASM,ESM,IBC\nAAA,EQ,Stage 2,0,0,0,0\nBBB,EQ,0,2,1,0,0\n');
  assert.equal(ri.get('AAA')!.gsm, 2);
  assert.equal(ri.get('BBB')!.ltAsm, 2);
  assert.equal(ri.get('BBB')!.stAsm, 1);
  assert.throws(() => parseSecList('foo,bar\n1,2'));
});

test('tradability gate blocks GSM, tight ASM, T2T and F&O ban (except reducing trades)', () => {
  const base = { instrument: eq, price: 100, bandBufferAtr: 1.5 };
  assert.equal(tradabilityGate({ ...base, flags: clean }).allowed, true);
  assert.equal(tradabilityGate({ ...base, flags: { ...clean, gsm: 1 } }).allowed, false);
  assert.equal(tradabilityGate({ ...base, flags: { ...clean, ltAsm: 2 } }).allowed, false);
  const asm1 = tradabilityGate({ ...base, flags: { ...clean, ltAsm: 1 } });
  assert.equal(asm1.allowed, true);
  assert.equal(asm1.sizeMultiplier, 0.5);
  assert.equal(tradabilityGate({ ...base, instrument: { ...eq, series: 'BE' }, flags: { ...clean, series: 'BE' } }).allowed, false);
  const banFut = { ...base, instrument: fut, flags: undefined, underlyingFlags: { ...clean, inFnoBan: true } };
  assert.equal(tradabilityGate(banFut).allowed, false);
  assert.equal(tradabilityGate({ ...banFut, reduceOnly: true }).allowed, true);
});

test('band proximity and band lock', () => {
  const band = staticBand(100, 5); // 95.00 – 105.00
  assert.equal(band.upper, 105);
  assert.equal(band.lower, 95);
  const near = tradabilityGate({ instrument: eq, price: 104, atr: 1, band, bandBufferAtr: 1.5, flags: clean });
  assert.equal(near.allowed, false);
  assert.match(near.reasons[0], /NEAR_BAND/);
  const locked = tradabilityGate({ instrument: eq, price: 105, atr: 1, band, bandBufferAtr: 1.5, flags: clean });
  assert.match(locked.reasons[0], /BAND_LOCKED_UPPER/);
  assert.equal(bandDistance(100, band, 1).nearestAtr, 5);
});

test('dynamic F&O band flexes 5% after a 15-minute cooling-off at the band; opposite band slides', () => {
  const db = new DynamicBand(1000);
  assert.deepEqual([db.band().lower, db.band().upper], [900, 1100]);
  let flexed = false;
  for (let t = 0; t <= 16 * 60_000; t += 60_000) flexed = db.onTrade(t, 1099) || flexed;
  assert.equal(flexed, true);
  assert.deepEqual([db.band().lower, db.band().upper], [950, 1150]);
});

test('freak-trade filter drops tiny prints far from VWAP only', () => {
  assert.equal(isFreakTrade(130, 1, 100, 2, 500), true);
  assert.equal(isFreakTrade(130, 5000, 100, 2, 500), false);
  assert.equal(isFreakTrade(101, 1, 100, 2, 500), false);
});
