// Strategy interface. Strategies are deterministic: they decide SIDE and levels
// only. Size is decided by the risk engine; the LLM never sizes (plan rule).
// Strategies only propose entries; exits are handled by broker-side stops,
// the position monitor (targets, time stops, EOD square-off) and PROTECT verdicts.

import type { Anomaly, Bar, Instrument, ResearchVerdict, Signal } from '../core/types.ts';
import type { MetaFeatures } from '../ml/metaLabel.ts';
import { atr, efficiencyRatio, emaSeries, rsi, vwap } from '../features/technical.ts';
import { IST_OFFSET_MS } from '../core/clock.ts';
import { minutesSinceOpen } from '../config/calendar.ts';

export type Regime = 'trend' | 'range' | 'highvol' | 'unknown';

export interface StrategyContext {
  now: number;
  inst: Instrument;
  bars: Bar[];
  todayBars: Bar[];
  ltp: number;
  atr?: number;
  vwap?: number;
  sigma1m: number;
  verdict?: ResearchVerdict;
  recentAnomalies: Anomaly[];
  hasPosition: boolean;
  regime: Regime;
  spreadBps?: number;
}

export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly params: Record<string, number>;
  /** Asset classes this strategy trades. */
  readonly venues: Instrument['venue'][];
  evaluate(ctx: StrategyContext): Omit<Signal, 'strategyId' | 'ts'> | undefined;
}

export function buildContext(now: number, inst: Instrument, bars: Bar[], ltp: number, sigma1m: number, extra: Partial<StrategyContext>): StrategyContext {
  // Today's bars: walk back from the end while still on the same IST day (cheap integer maths).
  const day = (t: number) => Math.floor((t + IST_OFFSET_MS) / 86_400_000);
  const today = day(now);
  let i = bars.length;
  while (i > 0 && day(bars[i - 1].ts) === today) i--;
  const todayBars = bars.slice(i);
  const closes = bars.slice(-60).map((b) => b.close);
  const er = efficiencyRatio(closes, 30);
  const annVolProxy = sigma1m * Math.sqrt(375 * 252);
  const regime: Regime = annVolProxy > 0.6 ? 'highvol' : er === undefined ? 'unknown' : er > 0.35 ? 'trend' : 'range';
  return {
    now, inst, bars, todayBars, ltp, sigma1m, regime,
    atr: atr(bars.slice(-60), 14),
    vwap: vwap(todayBars),
    recentAnomalies: [],
    hasPosition: false,
    ...extra,
  };
}

export function metaFeatures(ctx: StrategyContext, strength: number): MetaFeatures {
  const closes = ctx.bars.slice(-60).map((b) => b.close);
  const r = rsi(closes, 14);
  const vols = ctx.bars.slice(-30).map((b) => b.volume).sort((a, b) => a - b);
  const medVol = vols[Math.floor(vols.length / 2)] || 1;
  const lastVol = ctx.bars[ctx.bars.length - 1]?.volume ?? 0;
  return {
    strength,
    sigmaBps: ctx.sigma1m * 1e4,
    efficiencyRatio: efficiencyRatio(closes, 30),
    rvol: lastVol / medVol,
    minuteOfSession: minutesSinceOpen(ctx.now),
    rsiDist: r !== undefined ? Math.abs(r - 50) : undefined,
    vwapDistAtr: ctx.vwap && ctx.atr ? (ctx.ltp - ctx.vwap) / ctx.atr : undefined,
    researchConf: ctx.verdict?.calibratedConfidence,
    spreadBps: ctx.spreadBps,
    regimeTrend: ctx.regime === 'trend' ? 1 : ctx.regime === 'range' ? -1 : 0,
  };
}

export { emaSeries };
