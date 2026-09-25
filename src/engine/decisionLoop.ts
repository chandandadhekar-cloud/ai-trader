// The 1-minute decision loop (plan §F "Loop changes"):
//   pre-step : compliance health, reconciliation, session phase, tradability gate,
//              staleness
//   async in : fresh research.verdict events (read, never awaited)
//   step     : strategies → ensemble → meta-label veto / bet size → risk sizing
//   post-step: OMS; protective stop must be confirmed at the broker before the
//              trade counts as open (handled in the OMS)
// The same loop runs in backtest (driven by the backtester), paper and live.

import type { Instrument, Signal } from '../core/types.ts';
import type { EventBus } from '../core/events.ts';
import type { Db } from '../db/database.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { StalenessMonitor } from '../marketdata/staleness.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import type { SurveillanceService } from '../surveillance/service.ts';
import type { RuntimeConfig } from '../config/runtime.ts';
import type { RiskEngine } from '../risk/engine.ts';
import type { Oms } from '../oms/oms.ts';
import type { StrategyRegistry } from '../strategies/registry.ts';
import type { ShadowTracker } from '../governance/shadow.ts';
import type { ResearchService } from '../research/service.ts';
import type { MetaModel } from '../ml/metaLabel.ts';
import { betSize, predictMeta } from '../ml/metaLabel.ts';
import { buildContext, metaFeatures } from '../strategies/base.ts';
import { combineSignals } from '../strategies/ensemble.ts';
import { tradabilityGate, type GateResult } from '../surveillance/tradability.ts';
import { intradayCutoffs, sessionState } from '../config/calendar.ts';
import { instrumentClass } from '../monitor/positionMonitor.ts';
import { istParts } from '../core/clock.ts';

export interface LoopDeps {
  bus: EventBus;
  db: Db;
  quotes: QuoteBook;
  staleness: StalenessMonitor;
  refdata: InstrumentRegistry;
  surveillance: SurveillanceService;
  rc: RuntimeConfig;
  risk: RiskEngine;
  paperOms: Oms;
  liveOms?: Oms;
  strategies: StrategyRegistry;
  shadow: ShadowTracker;
  research?: ResearchService;
  metaModel: () => MetaModel | undefined;
  /** Live-mode compliance health; undefined in paper-only processes. */
  liveHealthy?: () => boolean;
  alwaysOpen: boolean;
  /** Agent control: false when paused/stopped (exits still run elsewhere). */
  entriesAllowed?: () => boolean;
  /** Leverage for an instrument per trade settings (1 = cash). */
  leverageFor?: (inst: Instrument) => number;
  now: () => number;
  universe: () => Instrument[];
  recentAnomalies: (key: string, sinceTs: number) => import('../core/types.ts').Anomaly[];
}

export interface LoopStats {
  runs: number;
  lastRunAt?: number;
  lastRunMs: number;
  signals: number;
  accepted: number;
  rejected: number;
  shadow: number;
  skipped: Record<string, number>;
}

export class DecisionLoop {
  private d: LoopDeps;
  stats: LoopStats = { runs: 0, lastRunMs: 0, signals: 0, accepted: 0, rejected: 0, shadow: 0, skipped: {} };
  private lastMinute = 0;

  constructor(d: LoopDeps) {
    this.d = d;
  }

  private skip(reason: string): void {
    this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
  }

  gateFor(inst: Instrument, reduceOnly = false): GateResult {
    const d = this.d;
    const L = d.rc.get('risk');
    const sym = inst.underlying ?? inst.symbol;
    const q = d.quotes.get(inst.key);
    const survFresh = d.surveillance.isFresh();
    const g = tradabilityGate({
      instrument: inst,
      flags: d.surveillance.get(inst.symbol),
      underlyingFlags: d.surveillance.get(sym),
      price: q?.last?.ltp ?? 0,
      atr: d.quotes.atr(inst.key),
      band: q?.band,
      reduceOnly,
      bandBufferAtr: L.bandBufferAtr,
      researchBlocked: d.research?.blockedToday(inst.key, d.now()),
      stale: d.staleness.isStale(inst.key, d.now()),
    });
    if (!survFresh && inst.venue !== 'DELTA' && !reduceOnly) {
      g.allowed = false;
      g.sizeMultiplier = 0;
      g.reasons.push('SURVEILLANCE_STALE: today\'s NSE files not loaded');
    }
    return g;
  }

  /** Run once per completed minute. */
  async run(): Promise<void> {
    const d = this.d;
    const now = d.now();
    const minute = now - (now % 60_000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    const t0 = performance.now();
    this.stats.runs++;
    this.stats.lastRunAt = now;
    try {
      await this.step(now);
    } finally {
      this.stats.lastRunMs = Math.round(performance.now() - t0);
    }
  }

  private async step(now: number): Promise<void> {
    const d = this.d;
    const date = istParts(now).date;
    const mod = istParts(now).minuteOfDay;
    const acct = d.risk.checkAccount(now);
    if (acct.halted) return this.skip('account_halted');
    if (d.entriesAllowed && !d.entriesAllowed()) return this.skip('agent_not_running');
    if (!d.paperOms.reconciled) return this.skip('paper_not_reconciled');

    const raw: Signal[] = [];
    for (const inst of d.universe()) {
      if (inst.type === 'INDEX') continue;
      if (!d.alwaysOpen && inst.venue !== 'DELTA') {
        const cls = instrumentClass(inst);
        const ss = sessionState(now, cls);
        if (!ss.entriesAllowed) { this.skip('session_closed'); continue; }
        if (mod >= intradayCutoffs(date, cls).lastEntry) { this.skip('past_last_entry'); continue; }
      }
      const q = d.quotes.get(inst.key);
      if (!q?.last) continue;
      const bars = d.quotes.bars(inst.key, 400);
      if (bars.length < 30) { this.skip('warmup'); continue; }
      const verdict = d.research?.freshVerdict(inst.key, now);
      const spreadBps = q.last.bid && q.last.ask ? ((q.last.ask - q.last.bid) / q.last.ltp) * 1e4 : undefined;
      const ctx = buildContext(now, inst, bars, q.last.ltp, q.sigma1m, {
        verdict,
        recentAnomalies: d.recentAnomalies(inst.key, now - 30 * 60_000),
        hasPosition: d.paperOms.portfolio.byInstrument(inst.key).length > 0 || !!d.liveOms?.portfolio.byInstrument(inst.key).length,
        spreadBps,
      });
      if (ctx.hasPosition) continue;
      for (const s of d.strategies.strategies) {
        if (!s.venues.includes(inst.venue)) continue;
        const stage = d.strategies.stage(s.id);
        if (stage === 'disabled') continue;
        let out;
        try {
          out = s.evaluate(ctx);
        } catch (e) {
          d.bus.publish('system', { kind: 'strategy.error', message: `${s.id} failed on ${inst.symbol}: ${String(e)}` });
          continue;
        }
        if (!out) continue;
        const sig: Signal = { ...out, strategyId: s.id, ts: now };
        // Meta-label on the individual primary signal.
        const model = d.metaModel();
        if (model) sig.metaProb = predictMeta(model, metaFeatures(ctx, sig.strength));
        raw.push(sig);
      }
    }
    this.stats.signals += raw.length;
    if (!raw.length) return;

    const { accepted, rejected } = combineSignals(raw);
    for (const r of rejected) this.record(r.signal, 'rejected', [r.reason]);

    const L = d.rc.get('risk');
    for (const sig of accepted) {
      const inst = d.refdata.byKey(sig.instrumentKey)!;
      const stage = d.strategies.stage(sig.strategyId);
      if (sig.metaProb !== undefined && sig.metaProb < L.minMetaProb) {
        this.record(sig, 'rejected', [`meta-label veto: p=${sig.metaProb.toFixed(2)} < ${L.minMetaProb}`]);
        continue;
      }
      const metaSize = sig.metaProb !== undefined ? Math.max(0.25, betSize(sig.metaProb)) : 1;
      const gate = this.gateFor(inst);
      if (stage === 'shadow') {
        d.shadow.add(sig);
        this.record(sig, 'shadow', gate.allowed ? [] : gate.reasons);
        continue;
      }
      const useLive = stage === 'live' && !!d.liveOms;
      if (useLive && d.liveHealthy && !d.liveHealthy()) {
        this.record(sig, 'rejected', ['live compliance / health check failing']);
        continue;
      }
      if (useLive && !d.liveOms!.reconciled) {
        this.record(sig, 'rejected', ['live book not reconciled']);
        continue;
      }
      const leverage = d.leverageFor ? d.leverageFor(inst) : 1;
      const decision = d.risk.size(sig, inst, gate, metaSize, now, date, leverage);
      if (!decision.approved) {
        this.record(sig, 'rejected', decision.reasons);
        continue;
      }
      const oms = useLive ? d.liveOms! : d.paperOms;
      const order = await oms.submitEntry(sig, decision.qty, inst, 'I', leverage);
      if (!order || order.status === 'REJECTED') {
        this.record(sig, 'rejected', [order?.reason ?? 'no price for entry']);
        continue;
      }
      this.record(sig, 'accepted', [...decision.reasons, `qty ${decision.qty}`, `notional ₹${Math.round(decision.notional)}`, `margin ₹${Math.round(decision.notional / leverage)} at ${leverage}x`, `max loss at stop ₹${Math.round(decision.riskAmount)}`, `${useLive ? 'LIVE' : 'PAPER'} ${order.clientOrderId}`]);
    }
  }

  private record(sig: Signal, decision: 'accepted' | 'rejected' | 'shadow', reasons: string[]): void {
    if (decision === 'accepted') this.stats.accepted++;
    else if (decision === 'rejected') this.stats.rejected++;
    else this.stats.shadow++;
    this.d.db.run(
      'INSERT INTO signals (ts, strategy_id, instrument_key, side, strength, meta_prob, entry, stop, target, decision, reasons, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      sig.ts, sig.strategyId, sig.instrumentKey, sig.side, sig.strength, sig.metaProb ?? null, sig.entry, sig.stop, sig.target ?? null, decision, JSON.stringify(reasons), JSON.stringify(sig),
    );
    this.d.bus.publish('signal', { ...sig, decision, rejectReasons: reasons });
  }
}
