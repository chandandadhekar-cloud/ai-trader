// Event-driven backtester (plan §G / Phase 3). It wires the SAME strategies, risk
// engine, OMS, paper broker, position monitor and decision loop used live, driven
// by a simulated clock over 1-minute bars. No look-ahead: signals formed at bar t's
// close are filled against bar t+1 (open, then range) by the fill simulator.
//
// LLM research is not replayed by default: any LLM score for news dated before the
// model's training cutoff is contaminated (plan §P0.5), so verdict-driven
// strategies only trade in backtests on post-cutoff verdict replays.

import type { Bar, Instrument } from '../core/types.ts';
import { Db } from '../db/database.ts';
import { SimClock, istDate } from '../core/clock.ts';
import { EventBus } from '../core/events.ts';
import { AuditLog } from '../governance/auditLog.ts';
import { RuntimeConfig, type RiskLimits } from '../config/runtime.ts';
import { InstrumentRegistry } from '../refdata/instruments.ts';
import { QuoteBook } from '../marketdata/quoteBook.ts';
import { StalenessMonitor } from '../marketdata/staleness.ts';
import { SurveillanceService } from '../surveillance/service.ts';
import { Portfolio } from '../oms/portfolio.ts';
import { KillSwitch } from '../risk/killSwitch.ts';
import { RiskEngine } from '../risk/engine.ts';
import { PaperBroker } from '../brokers/paper.ts';
import { Oms } from '../oms/oms.ts';
import { TrialRegistry } from '../validation/trialRegistry.ts';
import { StrategyRegistry } from '../strategies/registry.ts';
import { ShadowTracker } from '../governance/shadow.ts';
import { PositionMonitor } from '../monitor/positionMonitor.ts';
import { DecisionLoop } from '../engine/decisionLoop.ts';
import type { Strategy } from '../strategies/base.ts';
import type { MetaModel } from '../ml/metaLabel.ts';
import { DEFAULT_SIM, type SimParams } from './fillSimulator.ts';
import { mean, sharpe, std } from '../validation/statsUtil.ts';
import { cpcv } from '../ml/cv.ts';

export interface BacktestOptions {
  instruments: Instrument[];
  bars: Map<string, Bar[]>;
  strategies: Strategy[];
  capital: number;
  risk?: Partial<RiskLimits>;
  sim?: Partial<SimParams>;
  metaModel?: MetaModel;
  /** Ignore NSE session rules (synthetic data only). */
  alwaysOpen?: boolean;
  /** Cancel unfilled entries after this many bars. */
  entryExpiryBars?: number;
  equitySampleMinutes?: number;
}

export interface BacktestMetrics {
  startEquity: number;
  endEquity: number;
  totalReturn: number;
  days: number;
  dailySharpe: number;
  annualisedSharpe: number;
  maxDrawdown: number;
  trades: number;
  winRate: number;
  expectancy: number;
  avgR?: number;
  profitFactor: number;
  fees: number;
  turnover: number;
  exposureFraction: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  dailyReturns: number[];
  dailyDates: string[];
  equityCurve: { ts: number; equity: number }[];
  trades: Portfolio['closedTrades'];
  foldSharpes: number[];
  signals: { accepted: number; rejected: number; shadow: number };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

export async function runBacktest(o: BacktestOptions): Promise<BacktestResult> {
  const timeline = new Map<number, Bar[]>();
  for (const [, bs] of o.bars) for (const b of bs) {
    let l = timeline.get(b.ts);
    if (!l) timeline.set(b.ts, (l = []));
    l.push(b);
  }
  const times = [...timeline.keys()].sort((a, b) => a - b);
  if (!times.length) throw new Error('no bars');

  const db = new Db(':memory:');
  const clock = new SimClock(times[0]);
  const now = () => clock.now();
  const bus = new EventBus(now);
  const audit = new AuditLog(db, now);
  const rc = new RuntimeConfig(db, audit);
  if (o.risk) rc.update('risk', o.risk, 'backtest');
  const refdata = new InstrumentRegistry();
  for (const i of o.instruments) refdata.upsert(i);
  const quotes = new QuoteBook();
  const staleness = new StalenessMonitor(1e9, 24 * 3600_000, 1e12);
  const surveillance = new SurveillanceService(db, bus, now, true);
  const portfolio = new Portfolio(db, quotes, refdata, 'backtest', o.capital);
  const kill = new KillSwitch(db, bus, audit);
  const risk = new RiskEngine({ portfolio, quotes, kill, refdata, limits: () => rc.get('risk') });
  const broker = new PaperBroker({ quotes, refdata, buildHeaders: () => ({ 'X-Algo-Name': 'backtest' }), isContinuous: () => true, now, simParams: { ...DEFAULT_SIM, ...o.sim } });
  broker.deferFills = true;
  const oms = new Oms({ broker, db, bus, refdata, quotes, audit, portfolio, mode: 'backtest', algoName: 'backtest', now });
  oms.useTimers = false;
  oms.reconciled = true;
  oms.onTradeClosed = (sid, pnl, date) => risk.recordTradeResult(sid, pnl, date);
  const trials = new TrialRegistry(db);
  const registry = new StrategyRegistry(db, audit, trials, o.strategies);
  for (const s of o.strategies) db.run("UPDATE strategies SET stage = 'paper' WHERE id = ?", s.id);
  const shadow = new ShadowTracker();
  const monitor = new PositionMonitor({ oms, refdata, quotes, bus, staleness, alwaysOpen: !!o.alwaysOpen, now });
  const loop = new DecisionLoop({
    bus, db, quotes, staleness, refdata, surveillance, rc, risk, paperOms: oms, strategies: registry, shadow,
    metaModel: () => o.metaModel, alwaysOpen: !!o.alwaysOpen, now, universe: () => o.instruments, recentAnomalies: () => [],
  });

  const expiry = (o.entryExpiryBars ?? 2) * 60_000;
  const sampleEvery = (o.equitySampleMinutes ?? 15) * 60_000;
  const equityCurve: { ts: number; equity: number }[] = [];
  const dayEnd = new Map<string, number>();
  let turnover = 0;
  let exposedBars = 0;
  bus.on('fill', (f) => { turnover += f.qty * f.price; });

  for (const ts of times) {
    const bars = timeline.get(ts)!;
    clock.set(Math.max(clock.now(), ts + 59_999));
    // 1) resting orders meet this bar (they were placed at an earlier close)
    for (const b of bars) broker.onMarketBar(b);
    await flush();
    // 2) the bar closes: update market state
    for (const b of bars) {
      quotes.onTick({ key: b.key, ltp: b.close, ltt: ts + 59_999, recvTs: ts + 59_999, ltq: b.volume, source: 'backtest' });
      quotes.onBar(b);
      staleness.observe(b.key, ts + 59_999, ts + 59_999);
    }
    // 3) expire stale entries, run exits, then the decision loop
    for (const ord of oms.openOrders()) if (ord.purpose === 'entry' && clock.now() - ord.createdAt >= expiry) await oms.cancel(ord.clientOrderId, 'entry expiry');
    await monitor.tick();
    await loop.run();
    await flush();
    if (portfolio.open().length) exposedBars++;
    const eq = portfolio.equity();
    if (!equityCurve.length || ts - equityCurve[equityCurve.length - 1].ts >= sampleEvery) equityCurve.push({ ts, equity: eq });
    dayEnd.set(istDate(ts), eq);
  }

  // Daily returns from end-of-day equity.
  const dates = [...dayEnd.keys()].sort();
  const eqs = dates.map((d) => dayEnd.get(d)!);
  const daily: number[] = [];
  let prev = o.capital;
  for (const e of eqs) {
    daily.push(prev > 0 ? e / prev - 1 : 0);
    prev = e;
  }
  let peak = o.capital;
  let mdd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  const trades = portfolio.closedTrades;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.netPnl, 0);
  const rs = trades.map((t) => t.rMultiple).filter((x): x is number => x !== undefined);
  const endEquity = portfolio.equity();

  // Fold stability: CPCV-style test sets over daily returns (6 groups, 2 test groups).
  const foldSharpes: number[] = [];
  if (daily.length >= 12) {
    const spans = daily.map((_, i) => ({ t0: i, t1: i }));
    for (const sp of cpcv(spans, 6, 2, 0).splits) foldSharpes.push(sharpe(sp.test.map((i) => daily[i])));
  }

  db.close();
  return {
    metrics: {
      startEquity: o.capital,
      endEquity,
      totalReturn: endEquity / o.capital - 1,
      days: daily.length,
      dailySharpe: sharpe(daily),
      annualisedSharpe: sharpe(daily) * Math.sqrt(252),
      maxDrawdown: mdd,
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      expectancy: trades.length ? mean(trades.map((t) => t.netPnl)) : 0,
      avgR: rs.length ? mean(rs) : undefined,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      fees: portfolio.feesPaid,
      turnover,
      exposureFraction: times.length ? exposedBars / times.length : 0,
    },
    dailyReturns: daily,
    dailyDates: dates,
    equityCurve,
    trades,
    foldSharpes,
    signals: { accepted: loop.stats.accepted, rejected: loop.stats.rejected, shadow: loop.stats.shadow },
  };
}

/** Synthetic historical 1-minute bars on real NSE session times (for demos and tests). */
export function syntheticHistory(instruments: Instrument[], days: number, endDate: string, seed = 1, isTradingDay: (d: string) => boolean = () => true): Map<string, Bar[]> {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const dates: string[] = [];
  let d = new Date(`${endDate}T00:00:00Z`);
  while (dates.length < days) {
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && isTradingDay(ds)) dates.unshift(ds);
    d = new Date(d.getTime() - 86400_000);
  }
  const out = new Map<string, Bar[]>();
  const idx = instruments.find((i) => i.type === 'INDEX');
  const prices = new Map(instruments.map((i) => [i.key, 100 + rand() * 900]));
  for (const i of instruments) out.set(i.key, []);
  for (const ds of dates) {
    const open = Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10), 3, 45); // 09:15 IST
    const regimeDrift = (rand() - 0.5) * 0.0004;
    for (let m = 0; m < 375; m++) {
      const u = 0.7 + 1.2 * ((m / 375 - 0.5) ** 2) * 4 * 0.5;
      const idxR = 0.0006 * u * gauss() + regimeDrift * 0.2;
      for (const i of instruments) {
        const p0 = prices.get(i.key)!;
        const r = i === idx ? idxR : idxR * (0.6 + rand() * 0.8) + 0.0009 * u * gauss() + regimeDrift;
        const p1 = Math.max(1, p0 * Math.exp(r));
        const hi = Math.max(p0, p1) * (1 + Math.abs(gauss()) * 0.0003);
        const lo = Math.min(p0, p1) * (1 - Math.abs(gauss()) * 0.0003);
        const round = (x: number) => Math.round(x / i.tickSize) * i.tickSize;
        out.get(i.key)!.push({ key: i.key, ts: open + m * 60_000, open: round(p0), high: round(hi), low: round(lo), close: round(p1), volume: i.type === 'INDEX' ? 0 : Math.round((20000 + rand() * 20000) * u) });
        prices.set(i.key, p1);
      }
    }
  }
  return out;
}

export function summarise(r: BacktestResult): string {
  const m = r.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return [
    `Days ${m.days} | Trades ${m.trades} | Win ${pct(m.winRate)} | PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}`,
    `Return ${pct(m.totalReturn)} | Sharpe(ann.) ${m.annualisedSharpe.toFixed(2)} | MaxDD ${pct(m.maxDrawdown)}`,
    `Expectancy ₹${m.expectancy.toFixed(0)}/trade | Avg R ${m.avgR?.toFixed(2) ?? 'n/a'} | Fees ₹${m.fees.toFixed(0)} | Turnover ₹${(m.turnover / 1e7).toFixed(2)} cr`,
    `Daily ret σ ${pct(std(r.dailyReturns))} | Exposure ${pct(m.exposureFraction)}`,
  ].join('\n');
}
