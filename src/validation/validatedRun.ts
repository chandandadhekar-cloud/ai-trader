// The full validation stack for one strategy selection (plan §G): main backtest,
// doubled-slippage rerun, a parameter family for PBO (CSCV), the Deflated Sharpe
// against every trial previously registered for the family, and the gates.
// Pure function of its inputs so it can run in a worker thread.

import type { Bar, Instrument } from '../core/types.ts';
import type { RiskLimits } from '../config/runtime.ts';
import { runBacktest, syntheticHistory, type BacktestMetrics } from '../sim/backtester.ts';
import { defaultStrategies, MeanReversion, OpeningRangeBreakout, TrendFollowing } from '../strategies/library.ts';
import { isTradingDay } from '../config/calendar.ts';
import { deflatedSharpe, type DsrResult } from './deflatedSharpe.ts';
import { pboCscv } from './pbo.ts';
import { evaluateGates, type GateReport } from './trialRegistry.ts';

export interface ValidatedRunInput {
  instruments: Instrument[];
  /** Stored bars; when absent synthetic history is generated. */
  bars?: [string, Bar[]][];
  days: number;
  endDate: string;
  seed: number;
  strategyId: string;
  capital: number;
  risk: RiskLimits;
  priorTrialSharpes: number[];
}

export interface ValidatedRunOutput {
  params: Record<string, unknown>;
  metrics: BacktestMetrics;
  doubledSlippage: BacktestMetrics;
  dsr: DsrResult;
  pbo?: number;
  gate: GateReport;
  foldSharpes: number[];
  equityCurve: { ts: number; equity: number }[];
  dailyReturns: number[];
  dailyDates: string[];
  trades: unknown[];
  family: { config: string; sharpe: number; trades: number; ret: number }[];
}

export async function validatedRun(inp: ValidatedRunInput): Promise<ValidatedRunOutput> {
  const bars = inp.bars ? new Map(inp.bars) : syntheticHistory(inp.instruments, inp.days, inp.endDate, inp.seed, isTradingDay);
  const all = defaultStrategies();
  const chosen = inp.strategyId === 'all' ? all : all.filter((s) => s.id === inp.strategyId);
  if (!chosen.length) throw new Error(`unknown strategy ${inp.strategyId}`);
  const base = { instruments: inp.instruments, bars, capital: inp.capital, risk: inp.risk };
  const main = await runBacktest({ ...base, strategies: chosen });
  const doubled = await runBacktest({ ...base, strategies: chosen, sim: { slippageMultiplier: 2 } });

  const family = [
    [new TrendFollowing({ fast: 10, slow: 30 })], [new TrendFollowing({ fast: 20, slow: 50 })], [new TrendFollowing({ fast: 30, slow: 90 })],
    [new MeanReversion({ stretchAtr: 2 })], [new MeanReversion({ stretchAtr: 3 })],
    [new OpeningRangeBreakout({ orMinutes: 15 })], [new OpeningRangeBreakout({ orMinutes: 30 })],
  ];
  const fam: Awaited<ReturnType<typeof runBacktest>>[] = [];
  for (const f of family) fam.push(await runBacktest({ ...base, strategies: f }));
  let pbo: number | undefined;
  const T = Math.min(...fam.map((r) => r.dailyReturns.length));
  if (T >= 8) {
    const matrix = Array.from({ length: T }, (_, t) => fam.map((r) => r.dailyReturns[t]));
    try {
      pbo = pboCscv(matrix, T >= 16 ? 8 : 4).pbo;
    } catch {
      pbo = undefined;
    }
  }
  const trialSharpes = [...inp.priorTrialSharpes, ...fam.map((r) => r.metrics.dailySharpe), main.metrics.dailySharpe];
  const dsr = deflatedSharpe(main.dailyReturns, trialSharpes);
  const gate = evaluateGates({ expectancyAfterCosts: main.metrics.expectancy, dsr: dsr.dsr, pbo, sharpeDoubledSlippage: doubled.metrics.dailySharpe, foldSharpes: main.foldSharpes });
  return {
    params: Object.fromEntries(chosen.map((s) => [s.id, s.params])),
    metrics: main.metrics,
    doubledSlippage: doubled.metrics,
    dsr,
    pbo,
    gate,
    foldSharpes: main.foldSharpes,
    equityCurve: main.equityCurve,
    dailyReturns: main.dailyReturns,
    dailyDates: main.dailyDates,
    trades: main.trades.slice(-300),
    family: fam.map((r, i) => ({ config: family[i].map((s) => `${s.id} ${JSON.stringify(s.params)}`).join(', '), sharpe: r.metrics.annualisedSharpe, trades: r.metrics.trades, ret: r.metrics.totalReturn })),
  };
}
