// Command-line backtest. Examples:
//   npm run backtest -- --days 20 --instruments 12
//   npm run backtest -- --csv data/bars.csv          (columns: key,ts,open,high,low,close,volume)
//   npm run backtest -- --strategy trend_following --slippage 2
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runBacktest, syntheticHistory, summarise } from '../sim/backtester.ts';
import { syntheticInstruments } from '../marketdata/syntheticFeed.ts';
import { defaultStrategies } from '../strategies/library.ts';
import { isTradingDay } from '../config/calendar.ts';
import { deflatedSharpe } from '../validation/deflatedSharpe.ts';
import type { Bar, Instrument } from '../core/types.ts';

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '20' },
    instruments: { type: 'string', default: '12' },
    strategy: { type: 'string', default: 'all' },
    csv: { type: 'string' },
    capital: { type: 'string', default: '1000000' },
    slippage: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    end: { type: 'string', default: new Date(Date.now() - 86400_000).toISOString().slice(0, 10) },
  },
});

let instruments: Instrument[];
let bars: Map<string, Bar[]>;
if (values.csv) {
  bars = new Map();
  const lines = readFileSync(values.csv, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()!.split(',').map((h) => h.trim().toLowerCase());
  const ix = (n: string) => header.indexOf(n);
  for (const l of lines) {
    const f = l.split(',');
    const key = f[ix('key')];
    const tsRaw = f[ix('ts')];
    const ts = /^\d+$/.test(tsRaw) ? Number(tsRaw) : Date.parse(tsRaw);
    const b: Bar = { key, ts, open: +f[ix('open')], high: +f[ix('high')], low: +f[ix('low')], close: +f[ix('close')], volume: +f[ix('volume')] };
    if (!bars.has(key)) bars.set(key, []);
    bars.get(key)!.push(b);
  }
  for (const l of bars.values()) l.sort((a, b) => a.ts - b.ts);
  instruments = [...bars.keys()].map((key) => ({ key, symbol: key.split('|').pop()!, venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: 0.05, series: 'EQ' }));
} else {
  instruments = syntheticInstruments().slice(0, Number(values.instruments) + 1);
  bars = syntheticHistory(instruments, Number(values.days), values.end!, Number(values.seed), isTradingDay);
  process.stdout.write('NOTE: synthetic random-walk data has no edge by construction; results only exercise the pipeline.\n');
}
const strategies = values.strategy === 'all' ? defaultStrategies() : defaultStrategies().filter((s) => s.id === values.strategy);
if (!strategies.length) throw new Error(`unknown strategy ${values.strategy}`);
const t0 = Date.now();
const r = await runBacktest({ instruments, bars, strategies, capital: Number(values.capital), sim: { slippageMultiplier: Number(values.slippage) } });
process.stdout.write(summarise(r) + '\n');
const d = deflatedSharpe(r.dailyReturns, [r.metrics.dailySharpe]);
process.stdout.write(`PSR(SR>0) ${(d.psrZero * 100).toFixed(1)}% | fold Sharpes ${r.foldSharpes.map((x) => x.toFixed(2)).join(' ')}\n`);
process.stdout.write(`signals ${JSON.stringify(r.signals)} | ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
