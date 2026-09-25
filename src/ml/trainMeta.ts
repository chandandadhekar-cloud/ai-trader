// Meta-label training (plan §P1.12). Replays the primary strategies bar by bar
// over history, labels every primary signal with the triple barrier defined by
// its own stop / target / time stop, and fits the meta-model. Out-of-sample
// quality is measured with CPCV (purged, embargoed); the model is saved only if
// taking trades with p >= threshold improves mean OOS R versus taking them all.
//   npm run train:meta -- --days 40            (synthetic history)
//   npm run train:meta -- --db data/tradeai.db (stored 1-minute bars)
//   add --dry-run to evaluate without saving
import { parseArgs } from 'node:util';
import type { Bar, Instrument } from '../core/types.ts';
import { Db } from '../db/database.ts';
import { syntheticHistory } from '../sim/backtester.ts';
import { syntheticInstruments } from '../marketdata/syntheticFeed.ts';
import { defaultStrategies } from '../strategies/library.ts';
import { buildContext, metaFeatures } from '../strategies/base.ts';
import { isTradingDay } from '../config/calendar.ts';
import { logReturns } from '../features/technical.ts';
import { std } from '../validation/statsUtil.ts';
import { cpcv } from './cv.ts';
import { predictMeta, trainMetaModel, type MetaFeatures } from './metaLabel.ts';

process.env.NODE_ENV = 'test';
const { values } = parseArgs({ options: { days: { type: 'string', default: '40' }, db: { type: 'string' }, threshold: { type: 'string', default: '0.5' }, 'dry-run': { type: 'boolean', default: false } } });

let instruments: Instrument[];
let bars: Map<string, Bar[]>;
const store = values.db ? new Db(values.db) : undefined;
if (store) {
  bars = new Map();
  for (const r of store.all<{ key: string }>('SELECT DISTINCT key FROM bars')) {
    bars.set(r.key, store.all<{ ts: number; o: number; h: number; l: number; c: number; v: number }>('SELECT ts, o, h, l, c, v FROM bars WHERE key = ? ORDER BY ts', r.key).map((b) => ({ key: r.key, ts: b.ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
  }
  instruments = [...bars.keys()].map((key) => ({ key, symbol: key.split('|').pop()!, venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: 0.05 }));
} else {
  instruments = syntheticInstruments().slice(1, 15);
  bars = syntheticHistory(instruments, Number(values.days), new Date(Date.now() - 86400_000).toISOString().slice(0, 10), 5, isTradingDay);
}

interface Sample { f: MetaFeatures; y: 0 | 1; r: number; t0: number; t1: number }
const samples: Sample[] = [];
for (const inst of instruments) {
  const bs = bars.get(inst.key) ?? [];
  for (let i = 60; i < bs.length - 1; i++) {
    const hist = bs.slice(Math.max(0, i - 400), i + 1);
    const sigma = std(logReturns(hist.slice(-60).map((b) => b.close)));
    const ctx = buildContext(bs[i].ts + 59_999, inst, hist, bs[i].close, sigma, {});
    for (const s of defaultStrategies()) {
      const sig = s.evaluate(ctx);
      if (!sig) continue;
      const risk = Math.abs(sig.entry - sig.stop);
      if (!(risk > 0)) continue;
      const long = sig.side === 'BUY';
      const horizon = sig.timeStopMin ?? 60;
      let r = 0;
      let j = i + 1;
      for (; j < Math.min(bs.length, i + 1 + horizon); j++) {
        const b = bs[j];
        if (long ? b.low <= sig.stop : b.high >= sig.stop) { r = -1; break; }
        if (sig.target !== undefined && (long ? b.high >= sig.target : b.low <= sig.target)) { r = Math.abs(sig.target - sig.entry) / risk; break; }
        r = ((b.close - sig.entry) * (long ? 1 : -1)) / risk;
      }
      samples.push({ f: metaFeatures(ctx, sig.strength), y: r > 0 ? 1 : 0, r, t0: bs[i].ts, t1: bs[Math.min(j, bs.length - 1)].ts });
    }
  }
}
samples.sort((a, b) => a.t0 - b.t0);
process.stdout.write(`primary signals labelled: ${samples.length} (base hit rate ${(samples.filter((s) => s.y).length / Math.max(samples.length, 1) * 100).toFixed(1)}%)\n`);
if (samples.length < 100) {
  process.stdout.write('not enough samples to train a meta-model\n');
  process.exit(0);
}
const thr = Number(values.threshold);
const { splits } = cpcv(samples, 6, 2, 60 * 60_000);
let allR = 0, allN = 0, takenR = 0, takenN = 0;
for (const sp of splits) {
  const m = trainMetaModel(sp.train.map((i) => samples[i].f), sp.train.map((i) => samples[i].y));
  for (const i of sp.test) {
    allR += samples[i].r; allN++;
    if (predictMeta(m, samples[i].f) >= thr) { takenR += samples[i].r; takenN++; }
  }
}
const base = allR / allN;
const filtered = takenN ? takenR / takenN : -Infinity;
process.stdout.write(`CPCV OOS mean R: all signals ${base.toFixed(3)} (${allN}) | meta-filtered ${filtered.toFixed(3)} (${takenN})\n`);
if (filtered > base && !values['dry-run']) {
  const model = trainMetaModel(samples.map((s) => s.f), samples.map((s) => s.y));
  const db = store ?? new Db('data/tradeai.db');
  db.run("INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES ('meta_model', ?, ?, 'train:meta') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", JSON.stringify(model), Date.now());
  process.stdout.write('meta-model saved (restart the app to load it)\n');
} else {
  process.stdout.write('meta-model NOT saved: no OOS improvement over taking every primary signal\n');
}
