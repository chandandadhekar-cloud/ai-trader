// Application wiring. One process runs the market-data pipeline, scanner,
// research consumer, decision loop, OMS(es) and the admin API. Components talk
// through the event bus; timers drive the per-second and per-minute cycles.

import { gunzipSync } from 'node:zlib';
import type { Settings } from './config/settings.ts';
import type { Anomaly, Bar, Instrument, Tick } from './core/types.ts';
import { Db } from './db/database.ts';
import { EventBus } from './core/events.ts';
import { AuditLog } from './governance/auditLog.ts';
import { RuntimeConfig } from './config/runtime.ts';
import { InstrumentRegistry } from './refdata/instruments.ts';
import { QuoteBook } from './marketdata/quoteBook.ts';
import { StalenessMonitor } from './marketdata/staleness.ts';
import { BarBuilder } from './marketdata/barBuilder.ts';
import { BackfillService } from './marketdata/backfill.ts';
import { SnapshotSweeper } from './marketdata/snapshotSweeper.ts';
import { SyntheticMarket, syntheticInstruments, SYNTH_INDEX_KEY } from './marketdata/syntheticFeed.ts';
import { SurveillanceService } from './surveillance/service.ts';
import { isFreakTrade } from './surveillance/freakTrade.ts';
import { Scanner } from './scanner/scanner.ts';
import { TierPromoter } from './scanner/promotion.ts';
import { KillSwitch } from './risk/killSwitch.ts';
import { RiskEngine } from './risk/engine.ts';
import { Portfolio } from './oms/portfolio.ts';
import { Oms } from './oms/oms.ts';
import { PaperBroker } from './brokers/paper.ts';
import { OrderThrottle } from './brokers/throttle.ts';
import { ComplianceGuard } from './brokers/compliance.ts';
import { UpstoxClient } from './brokers/upstox/rest.ts';
import { UpstoxFeed, TIER_CAPS } from './brokers/upstox/feed.ts';
import { DeltaClient } from './brokers/delta/rest.ts';
import { OpenAiLlm } from './research/llm.ts';
import { ResearchService } from './research/service.ts';
import { GdeltSource, NseAnnouncementsSource, SyntheticFilingSource, type NewsSource } from './research/sources.ts';
import { StrategyRegistry } from './strategies/registry.ts';
import { defaultStrategies } from './strategies/library.ts';
import { ShadowTracker } from './governance/shadow.ts';
import { TrialRegistry } from './validation/trialRegistry.ts';
import { PositionMonitor, instrumentClass } from './monitor/positionMonitor.ts';
import { DecisionLoop } from './engine/decisionLoop.ts';
import { Metrics } from './ops/metrics.ts';
import { AlertRouter } from './ops/alerts.ts';
import { TaxLedger } from './analytics/taxLedger.ts';
import { SkewMonitor, istParts } from './core/clock.ts';
import { sessionState } from './config/calendar.ts';
import { bandDistance } from './surveillance/bands.ts';
import type { MetaModel } from './ml/metaLabel.ts';
import { createLogger } from './core/logger.ts';

const log = createLogger('app');

export class App {
  readonly s: Settings;
  readonly db: Db;
  readonly bus: EventBus;
  readonly audit: AuditLog;
  readonly rc: RuntimeConfig;
  readonly refdata = new InstrumentRegistry();
  readonly quotes = new QuoteBook();
  readonly staleness = new StalenessMonitor();
  readonly skew = new SkewMonitor();
  readonly metrics = new Metrics();
  readonly bars: BarBuilder;
  readonly surveillance: SurveillanceService;
  readonly scanner: Scanner;
  readonly promoter: TierPromoter;
  readonly kill: KillSwitch;
  readonly paperPortfolio: Portfolio;
  readonly livePortfolio?: Portfolio;
  readonly risk: RiskEngine;
  readonly paperBroker: PaperBroker;
  readonly paperOms: Oms;
  readonly liveOms?: Oms;
  readonly throttle: OrderThrottle;
  readonly compliance: ComplianceGuard;
  readonly upstox?: UpstoxClient;
  feed?: UpstoxFeed;
  sweeper?: SnapshotSweeper;
  readonly backfill: BackfillService;
  readonly delta?: DeltaClient;
  readonly llm: OpenAiLlm;
  readonly research: ResearchService;
  readonly trials: TrialRegistry;
  readonly strategies: StrategyRegistry;
  readonly shadow: ShadowTracker;
  readonly monitor: PositionMonitor;
  readonly loop: DecisionLoop;
  readonly tax: TaxLedger;
  readonly alerts: AlertRouter;
  synthetic?: SyntheticMarket;
  metaModel?: MetaModel;
  readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private lastMinuteRun = 0;
  freakDropped = 0;
  ticks = 0;

  constructor(s: Settings) {
    this.s = s;
    this.db = new Db(s.DB_PATH);
    this.bus = new EventBus();
    this.audit = new AuditLog(this.db);
    this.rc = new RuntimeConfig(this.db, this.audit);
    this.trials = new TrialRegistry(this.db);
    this.tax = new TaxLedger(this.db);
    this.alerts = new AlertRouter(this.bus, s);
    const synthetic = s.DATA_SOURCE === 'synthetic';

    this.bars = new BarBuilder((b) => this.onBar(b));
    this.surveillance = new SurveillanceService(this.db, this.bus, Date.now, synthetic);
    this.scanner = new Scanner({ bus: this.bus, db: this.db, quotes: this.quotes, cfg: () => this.rc.get('scanner'), indexKey: synthetic ? SYNTH_INDEX_KEY : 'NSE_INDEX|Nifty 50' });
    this.promoter = new TierPromoter(TIER_CAPS.A_FULL);
    this.kill = new KillSwitch(this.db, this.bus, this.audit);
    this.paperPortfolio = new Portfolio(this.db, this.quotes, this.refdata, 'paper', s.CAPITAL_INR);
    if (s.MODE === 'live') this.livePortfolio = new Portfolio(this.db, this.quotes, this.refdata, 'live', s.CAPITAL_INR);
    // Risk is evaluated against the book that will carry the trade; live when present.
    this.risk = new RiskEngine({ portfolio: this.livePortfolio ?? this.paperPortfolio, quotes: this.quotes, kill: this.kill, refdata: this.refdata, limits: () => this.rc.get('risk') });

    this.throttle = new OrderThrottle(s.OPS_HARD_LIMIT, s.OPS_ALERT_AT, Date.now, (ops) =>
      this.bus.publish('alert', { severity: 'P1', title: 'Order rate high', message: `${ops} orders/sec (alert at ${s.OPS_ALERT_AT}, hard cap ${s.OPS_HARD_LIMIT}, exchange threshold 10)`, ts: Date.now() }),
    );
    // The compliance guard reads token presence lazily, so it can be built before the client.
    this.compliance = new ComplianceGuard(s, this.bus, () => !!this.upstox?.hasToken());
    if (s.UPSTOX_API_KEY || s.UPSTOX_ACCESS_TOKEN || s.DATA_SOURCE === 'upstox') this.upstox = new UpstoxClient(s, this.compliance, this.throttle);

    this.paperBroker = new PaperBroker({
      quotes: this.quotes, refdata: this.refdata, throttle: this.throttle,
      buildHeaders: () => this.compliance.orderHeaders(),
      isContinuous: (key) => this.isContinuous(key),
    });
    this.paperOms = new Oms({ broker: this.paperBroker, db: this.db, bus: this.bus, refdata: this.refdata, quotes: this.quotes, audit: this.audit, portfolio: this.paperPortfolio, mode: 'paper', algoName: s.UPSTOX_ALGO_NAME });
    this.paperOms.onTradeClosed = (sid, pnl, date) => this.risk.recordTradeResult(sid, pnl, date);
    if (s.MODE === 'live' && this.upstox && this.livePortfolio) {
      this.liveOms = new Oms({ broker: this.upstox, db: this.db, bus: this.bus, refdata: this.refdata, quotes: this.quotes, audit: this.audit, portfolio: this.livePortfolio, mode: 'live', algoName: s.UPSTOX_ALGO_NAME });
      this.liveOms.onTradeClosed = (sid, pnl, date) => this.risk.recordTradeResult(sid, pnl, date);
      this.upstox.startOrderPoller(2000);
    }
    if (s.CRYPTO_ENABLED) {
      this.delta = new DeltaClient({ base: s.DELTA_BASE_URL, key: s.DELTA_API_KEY, secret: s.DELTA_API_SECRET, live: s.MODE === 'live', deadmanMs: s.DELTA_DEADMAN_MS });
    }

    this.backfill = new BackfillService(this.db, async (key) => (this.upstox ? this.upstox.intraday(key) : []), (b) => { this.quotes.onBar(b); this.scanner.onBar(b); });

    // Research
    this.llm = new OpenAiLlm(this.db, s.OPENAI_API_KEY, s.LLM_MAX_CALLS_PER_DAY);
    const sources: NewsSource[] = [];
    if (synthetic) {
      this.synthetic = new SyntheticMarket((t) => this.onTick(t), { seed: Date.now() % 100000 });
      sources.push(new SyntheticFilingSource(this.synthetic.filings));
    } else {
      sources.push(new NseAnnouncementsSource(), new GdeltSource());
    }
    this.research = new ResearchService({
      bus: this.bus, db: this.db, rc: this.rc, settings: s, llm: this.llm,
      deps: {
        db: this.db, quotes: this.quotes, surveillance: this.surveillance, refdata: this.refdata, sources,
        positionOf: (key) => {
          const ps = [...this.paperPortfolio.byInstrument(key), ...(this.livePortfolio?.byInstrument(key) ?? [])];
          if (!ps.length) return undefined;
          const qty = ps.reduce((a, p) => a + p.qty, 0);
          return qty ? { qty, avgPrice: ps[0].avgPrice } : undefined;
        },
        globalCueKeys: synthetic ? { NIFTY: SYNTH_INDEX_KEY } : { NIFTY: 'NSE_INDEX|Nifty 50', BANKNIFTY: 'NSE_INDEX|Nifty Bank', INDIA_VIX: 'NSE_INDEX|India VIX' },
        now: Date.now,
      },
      gate: (key) => {
        const inst = this.refdata.byKey(key);
        const q = this.quotes.get(key);
        const a = this.quotes.atr(key) ?? 0;
        const d = q?.band && q.last ? bandDistance(q.last.ltp, q.band, a, inst?.tickSize ?? 0.05) : undefined;
        const vols = this.quotes.bars(key, 30).map((b) => b.volume).sort((x, y) => x - y);
        return {
          nearBand: !!d && d.nearestAtr < this.rc.get('risk').bandBufferAtr,
          bandLocked: !!d && (d.lockedLower || d.lockedUpper),
          isDerivative: !!inst && inst.type !== 'EQ' && inst.type !== 'INDEX',
          minuteTurnover: vols.length && q?.last ? vols[Math.floor(vols.length / 2)] * q.last.ltp : undefined,
        };
      },
    });

    this.strategies = new StrategyRegistry(this.db, this.audit, this.trials, defaultStrategies());
    this.shadow = new ShadowTracker(this.db);
    this.monitor = new PositionMonitor({ oms: this.paperOms, refdata: this.refdata, quotes: this.quotes, bus: this.bus, research: this.research, staleness: this.staleness, alwaysOpen: synthetic });
    const liveMonitor = this.liveOms ? new PositionMonitor({ oms: this.liveOms, refdata: this.refdata, quotes: this.quotes, bus: this.bus, research: this.research, staleness: this.staleness, alwaysOpen: false }) : undefined;
    this.liveMonitor = liveMonitor;
    const metaRow = this.db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'meta_model'");
    if (metaRow) this.metaModel = JSON.parse(metaRow.value);
    this.loop = new DecisionLoop({
      bus: this.bus, db: this.db, quotes: this.quotes, staleness: this.staleness, refdata: this.refdata, surveillance: this.surveillance,
      rc: this.rc, risk: this.risk, paperOms: this.paperOms, liveOms: this.liveOms, strategies: this.strategies, shadow: this.shadow,
      research: this.research, metaModel: () => this.metaModel, liveHealthy: this.liveOms ? () => this.compliance.status().liveReady : undefined,
      alwaysOpen: synthetic, now: Date.now, universe: () => this.tradableUniverse(), recentAnomalies: (key, since) => this.recentAnomalies(key, since),
    });

    this.bus.on('fill', () => this.metrics.inc('tradeai_fills_total', 'Fills'));
    this.bus.on('anomaly', (a) => {
      this.metrics.inc('tradeai_anomalies_total', 'Anomalies detected', 1, { type: a.type });
      // Dynamic promotion: a hot Tier B/C name moves into Tier A (Full mode).
      if ((a.tier === 'B' || a.tier === 'C') && !a.suppressed && this.feed) {
        const r = this.promoter.promote(a.key, a.ts);
        if (r) {
          try {
            this.feed.promote(a.key, r.evicted);
            this.scanner.setTier(a.key, 'A');
            if (r.evicted) this.scanner.setTier(r.evicted, 'B');
          } catch (e) {
            log.warn('promotion failed', { err: String(e) });
          }
        }
      } else {
        this.promoter.touch(a.key, a.ts);
      }
    });
  }

  readonly liveMonitor?: PositionMonitor;

  recentAnomalies(key: string, since: number): Anomaly[] {
    return this.bus.history('anomaly', 500).map((e) => e.data).filter((a) => a.key === key && a.ts >= since);
  }

  /** Tier A (Full mode) names + anything with a position are eligible for entries. */
  tradableUniverse(): Instrument[] {
    const keys = new Set(this.feed ? this.feed.tierKeys('A') : this.refdata.all().map((i) => i.key));
    for (const p of this.paperPortfolio.open()) keys.add(p.instrumentKey);
    return [...keys].map((k) => this.refdata.byKey(k)).filter((i): i is Instrument => !!i && i.type !== 'INDEX');
  }

  isContinuous(key: string): boolean {
    if (this.s.DATA_SOURCE === 'synthetic') return true;
    const inst = this.refdata.byKey(key);
    if (!inst) return false;
    if (inst.venue === 'DELTA') return true;
    return sessionState(Date.now(), instrumentClass(inst)).phase === 'CONTINUOUS';
  }

  onTick(t: Tick): void {
    this.ticks++;
    this.staleness.observe(t.key, t.recvTs, t.ltt);
    this.skew.observe(t.ltt, t.recvTs);
    const med = this.quotes.get(t.key)?.medianTradeQty;
    if (isFreakTrade(t.ltp, t.ltq, this.quotes.vwap(t.key), this.quotes.atr(t.key), med)) {
      this.freakDropped++;
      return;
    }
    this.quotes.onTick(t);
    this.bars.onTick(t);
    this.paperBroker.onMarket(t.key);
  }

  private onBar(b: Bar): void {
    this.quotes.onBar(b);
    this.backfill.saveBar(b);
    this.scanner.onBar(b);
    this.shadow.onBar(b);
  }

  // ---- lifecycle ---------------------------------------------------------------

  async start(): Promise<void> {
    log.info('starting', { mode: this.s.MODE, data: this.s.DATA_SOURCE, db: this.s.DB_PATH });
    this.audit.append('system', 'app.start', null, { mode: this.s.MODE, dataSource: this.s.DATA_SOURCE, liveEnabled: this.s.LIVE_TRADING_ENABLED });

    if (this.s.DATA_SOURCE === 'synthetic') {
      for (const i of syntheticInstruments()) {
        this.refdata.upsert(i);
        this.scanner.register(i, 'A');
      }
      for (const [k, pc] of this.synthetic!.prevCloses()) this.quotes.setPrevClose(k, pc);
      this.warmupSynthetic();
      this.synthetic!.start();
    } else {
      await this.startUpstoxData();
    }
    if (this.delta) await this.startDelta();

    // Restore simulated broker state and reconcile before any new signal.
    this.paperBroker.seedPositions(this.paperPortfolio.open().map((p) => ({ instrumentKey: p.instrumentKey, qty: p.qty, avgPrice: p.avgPrice })));
    await this.paperOms.reconcile();
    if (this.liveOms) {
      await this.compliance.checkEgressIp();
      if (this.upstox?.hasToken()) await this.liveOms.reconcile();
    }

    this.every(1000, () => this.perSecond());
    this.every(60_000, () => this.perMinute());
    if (this.s.MODE === 'live') this.every(5 * 60_000, () => this.compliance.checkEgressIp());
    if (this.liveOms) this.every(5 * 60_000, async () => { if (this.upstox?.hasToken()) await this.liveOms!.reconcile(); });
    this.every(60_000, () => this.dailyJobs());
    if (this.s.WATCHDOG_URL) this.every(15_000, () => this.heartbeat());
  }

  private every(ms: number, fn: () => unknown): void {
    const t = setInterval(() => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((e) => log.error('timer job failed', { err: String(e?.stack ?? e) }));
      } catch (e) {
        log.error('timer job failed', { err: String((e as Error)?.stack ?? e) });
      }
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  /** Replay ~2.5 hours of the same synthetic market so strategies and the scanner start warm. */
  private warmupSynthetic(): void {
    const now = Date.now();
    const start = now - (now % 60_000) - 150 * 60_000;
    for (let ts = start; ts < now; ts += 2000) this.synthetic!.step(ts, 2000);
    this.bars.flush(now);
    this.scanner.processReady(now + 120_000);
  }

  private async startUpstoxData(): Promise<void> {
    if (!this.upstox) throw new Error('DATA_SOURCE=upstox requires Upstox credentials');
    try {
      const res = await fetch('https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz', { signal: AbortSignal.timeout(60_000) });
      const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as Record<string, unknown>[];
      const n = this.refdata.loadUpstoxMaster(rows.filter((r) => ['NSE_EQ', 'NSE_INDEX', 'NSE_FO', 'BSE_EQ'].includes(String(r.segment))));
      log.info('instrument master loaded', { n });
    } catch (e) {
      log.error('instrument master load failed', { err: String(e) });
    }
    await this.surveillance.refreshFromNse();
    // Tier A: indices + F&O underlyings (cash) + near-month index futures, capped.
    const fnoUnderlyings = new Set(this.refdata.all().filter((i) => i.segment === 'NSE_FO' && i.type === 'FUT').map((i) => i.underlying));
    const eq = this.refdata.all().filter((i) => i.segment === 'NSE_EQ' && i.type === 'EQ');
    const tierA = [
      ...this.refdata.all().filter((i) => i.segment === 'NSE_INDEX').slice(0, 20),
      ...eq.filter((i) => fnoUnderlyings.has(i.symbol)),
    ].slice(0, TIER_CAPS.A_FULL);
    const aKeys = new Set(tierA.map((i) => i.key));
    const tierB = eq.filter((i) => !aKeys.has(i.key)).slice(0, TIER_CAPS.B_LTPC);
    const bKeys = new Set(tierB.map((i) => i.key));
    const tierC = this.refdata.all().filter((i) => (i.segment === 'NSE_EQ' || i.segment === 'BSE_EQ') && !aKeys.has(i.key) && !bKeys.has(i.key));
    for (const i of tierA) { this.scanner.register(i, 'A'); this.promoter.promote(i.key, 0); }
    for (const i of tierB) this.scanner.register(i, 'B');
    for (const i of tierC) this.scanner.register(i, 'C');
    for (const i of tierA.filter((x) => x.type === 'INDEX')) this.promoter.pin(i.key);

    this.feed = new UpstoxFeed(() => this.upstox!.feedAuthorize(), (t) => this.onTick(t), (conn, downSince, keys) => {
      this.bus.publish('system', { kind: 'feed.reconnected', message: `${conn} reconnected after ${Math.round((Date.now() - downSince) / 1000)}s; backfilling` });
      void this.backfill.backfill(keys.slice(0, 200), downSince).then((n) => this.metrics.inc('tradeai_gaps_backfilled_total', 'Bars backfilled after reconnects', n));
    });
    this.feed.setTier('A', tierA.map((i) => i.key));
    this.feed.setTier('B', tierB.map((i) => i.key));
    this.sweeper = new SnapshotSweeper(this.upstox, (t) => this.onTick(t), (key, lo, hi) => {
      const inst = this.refdata.byKey(key);
      this.quotes.setBand(key, { lower: lo, upper: hi, pct: 0, dynamic: !!inst?.isFnO });
    }, 30_000);
    this.sweeper.setKeys([...tierC, ...tierA, ...tierB].map((i) => i.key));
    if (this.upstox.hasToken()) {
      await this.feed.start();
      this.sweeper.start();
    } else {
      log.warn('no Upstox token: complete the daily login from the admin console to start feeds');
    }
  }

  /** Called after the daily Upstox login completes. */
  async onUpstoxLogin(): Promise<void> {
    this.audit.append('admin', 'upstox.login', null, {});
    if (this.feed) {
      await this.feed.start();
      this.sweeper?.start();
    }
    if (this.liveOms) await this.liveOms.reconcile();
  }

  private async startDelta(): Promise<void> {
    try {
      await this.delta!.loadProducts();
      const poll = async () => {
        const tk = await this.delta!.tickers();
        const now = Date.now();
        for (const t of tk) {
          const key = t.symbol;
          if (!this.refdata.byKey(key)) {
            this.refdata.upsert({ key, symbol: key, venue: 'DELTA', segment: 'DELTA_PERP', type: 'PERP', lotSize: 1, tickSize: 0.5 });
            this.scanner.register(this.refdata.byKey(key)!, 'CRYPTO');
          }
          const px = Number(t.mark_price);
          if (!(px > 0)) continue;
          this.onTick({ key, ltp: px, ltt: t.timestamp ? Math.floor(t.timestamp / 1000) : now, recvTs: now, vtt: t.volume, oi: t.oi ? Number(t.oi) : undefined, bid: t.quotes?.best_bid ? Number(t.quotes.best_bid) : undefined, ask: t.quotes?.best_ask ? Number(t.quotes.best_ask) : undefined, source: 'delta_ws' });
        }
      };
      this.every(5000, poll);
      if (this.delta!.configured()) this.every(20_000, () => this.delta!.heartbeat());
    } catch (e) {
      log.error('delta start failed', { err: String(e) });
    }
  }

  private async perSecond(): Promise<void> {
    const now = Date.now();
    this.bars.flush(now);
    this.scanner.processReady(now);
    this.scanner.scanTicks(now);
    await this.monitor.tick();
    if (this.liveMonitor) await this.liveMonitor.tick();
    // Decision loop once per minute, shortly after bars close and the scanner ran.
    const minute = now - (now % 60_000);
    if (minute !== this.lastMinuteRun && now - minute >= 3000) {
      this.lastMinuteRun = minute;
      await this.loop.run();
    }
  }

  private perMinute(): void {
    const now = Date.now();
    this.paperPortfolio.snapshot(now);
    this.livePortfolio?.snapshot(now);
    this.scanner.labelForwardReturns(now);
    this.research.labelOutcomes((key, ts) => this.quotes.bars(key).find((b) => b.ts >= ts)?.close, now);
    this.updateMetrics();
  }

  private lastDaily?: string;
  private async dailyJobs(): Promise<void> {
    const p = istParts(Date.now());
    // 08:30 IST: refresh surveillance files before the pre-open.
    if (this.s.DATA_SOURCE === 'upstox' && p.hh === 8 && p.mm === 30 && this.lastDaily !== `${p.date}-surv`) {
      this.lastDaily = `${p.date}-surv`;
      await this.surveillance.refreshFromNse();
    }
    // 23:45 IST: log out the API session before the next trading day (SEBI requirement).
    if (this.upstox?.hasToken() && p.hh === 23 && p.mm === 45) {
      try {
        await this.upstox.logout();
        this.compliance.lastLogoutAt = Date.now();
        this.audit.append('system', 'upstox.logout', null, {});
      } catch (e) {
        this.bus.publish('alert', { severity: 'P1', title: 'Upstox logout failed', message: String(e), ts: Date.now() });
      }
    }
    // Monthly calibration refit (1st of month, 18:00 IST).
    if (p.date.endsWith('-01') && p.hh === 18 && p.mm === 0) this.research.refitCalibration();
  }

  private async heartbeat(): Promise<void> {
    try {
      await fetch(this.s.WATCHDOG_URL!, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: Date.now(), kill: this.kill.engaged() }), signal: AbortSignal.timeout(3000) });
    } catch {
      /* the watchdog alerts on missing heartbeats */
    }
  }

  updateMetrics(): void {
    const m = this.metrics;
    const pf = this.livePortfolio ?? this.paperPortfolio;
    const r = pf.refresh(Date.now());
    m.gauge('tradeai_equity_inr', 'Account equity', r.equity, { book: pf.mode });
    m.gauge('tradeai_drawdown_ratio', 'Drawdown from peak', r.drawdown, { book: pf.mode });
    m.gauge('tradeai_open_risk_inr', 'Open risk (sum of stop distances)', pf.openRisk(), { book: pf.mode });
    m.gauge('tradeai_open_positions', 'Open positions', pf.open().length, { book: pf.mode });
    m.gauge('tradeai_kill_switch', 'Kill switch engaged', this.kill.engaged() ? 1 : 0);
    m.gauge('tradeai_tick_lag_ms', 'Median exchange-to-local tick lag', this.staleness.medianLagMs() ?? 0);
    m.gauge('tradeai_clock_skew_ms', 'Estimated local clock skew vs exchange', this.skew.skewMs() ?? 0);
    m.gauge('tradeai_ops_peak', 'Peak orders per second', this.throttle.peakOps);
    m.gauge('tradeai_order_ack_latency_ms', 'Last order ack latency', (this.liveOms ?? this.paperOms).stats.lastAckLatencyMs);
    for (const [code, n] of Object.entries((this.liveOms ?? this.paperOms).stats.rejectReasons)) m.gauge('tradeai_order_rejections', 'Order rejections by reason', n, { reason: code });
    const u = this.llm.usageToday();
    m.gauge('tradeai_llm_calls_today', 'LLM calls today', u.calls);
    m.gauge('tradeai_llm_cost_usd_today', 'LLM cost today (USD)', u.costUsd);
    for (const [model, x] of Object.entries(u.byModel)) if (x.p95Ms) m.gauge('tradeai_llm_p95_ms', 'LLM p95 latency', x.p95Ms, { model });
    if (this.feed) for (const c of this.feed.status().connections) {
      m.gauge('tradeai_ws_connected', 'WebSocket connected', c.connected ? 1 : 0, { conn: c.name });
      m.gauge('tradeai_ws_reconnects', 'WebSocket reconnects', c.reconnects, { conn: c.name });
    }
    m.gauge('tradeai_research_queue', 'Research queue depth', this.research.queueDepth());
    m.gauge('tradeai_freak_trades_dropped', 'Freak prints dropped', this.freakDropped);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.synthetic?.stop();
    this.feed?.stop();
    this.sweeper?.stop();
    this.audit.append('system', 'app.stop', null, {});
    this.db.close();
  }
}
