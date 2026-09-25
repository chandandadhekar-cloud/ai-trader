// Research orchestration: runs as its own consumer of anomaly events and publishes
// `research.verdict` events that the signal engine reads only while fresh. It never
// blocks the decision loop.

import type { Anomaly, ResearchVerdict } from '../core/types.ts';
import type { EventBus } from '../core/events.ts';
import type { Db } from '../db/database.ts';
import type { RuntimeConfig } from '../config/runtime.ts';
import type { Settings } from '../config/settings.ts';
import type { LlmClient } from './llm.ts';
import { buildFactPack, type FactPackDeps } from './factPack.ts';
import { runCascade, runDeterministic, type AgentRun } from './agents.ts';
import { verifyVerdict } from './verify.ts';
import { mapVerdict } from './verdictMapper.ts';
import { Calibrator, fitIsotonic, type IsotonicModel } from './calibration.ts';
import { PROMPT_VERSION } from './prompts.ts';
import { newId } from '../core/ids.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('research');

interface Job {
  key: string;
  symbol: string;
  anomaly?: Anomaly;
  deep?: boolean;
  reason: string;
}

export class ResearchService {
  private bus: EventBus;
  private db: Db;
  private rc: RuntimeConfig;
  private s: Settings;
  private llm: LlmClient;
  private deps: FactPackDeps;
  private gate: (key: string) => { nearBand: boolean; bandLocked: boolean; isDerivative: boolean; minuteTurnover?: number };
  private queue: Job[] = [];
  private inflight = new Set<string>();
  private latest = new Map<string, ResearchVerdict>();
  private deepTimes: number[] = [];
  readonly calibrator: Calibrator;
  private concurrency = 3;
  private active = 0;
  stats = { requested: 0, completed: 0, cached: 0, failed: 0, dropped: 0, byPath: { fast: 0, deep: 0, deterministic: 0 } as Record<string, number> };

  constructor(opts: {
    bus: EventBus; db: Db; rc: RuntimeConfig; settings: Settings; llm: LlmClient; deps: FactPackDeps;
    gate: ResearchService['gate'];
  }) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.rc = opts.rc;
    this.s = opts.settings;
    this.llm = opts.llm;
    this.deps = opts.deps;
    this.gate = opts.gate;
    const row = this.db.get<{ value: string }>("SELECT value FROM kv_settings WHERE key = 'calibration_model'");
    this.calibrator = new Calibrator(row ? (JSON.parse(row.value) as IsotonicModel) : undefined);
    this.bus.on('anomaly', (a) => this.onAnomaly(a));
    this.bus.on('research.request', (r) => this.enqueue({ key: r.key, symbol: r.symbol, anomaly: r.anomaly, deep: r.deep, reason: r.reason }));
  }

  private onAnomaly(a: Anomaly): void {
    const cfg = this.rc.get('research');
    if (!cfg.enabled || a.suppressed) return;
    // Never research stale anomalies (replays, warm-up, backfill): the drift window has passed.
    if (Date.now() - a.ts > 5 * 60_000) return;
    const hasPosition = !!this.deps.positionOf(a.key);
    if (a.severity < this.rc.get('scanner').researchSeverityMin && !hasPosition) return;
    this.enqueue({ key: a.key, symbol: a.symbol, anomaly: a, reason: hasPosition ? 'position' : 'anomaly', deep: hasPosition || a.severity >= cfg.deepSeverityMin });
  }

  enqueue(j: Job): void {
    this.stats.requested++;
    if (this.inflight.has(j.key) || this.queue.some((q) => q.key === j.key)) { this.stats.dropped++; return; }
    if (this.queue.length > 50) { this.queue.shift(); this.stats.dropped++; }
    this.queue.push(j);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const j = this.queue.shift()!;
      this.active++;
      this.inflight.add(j.key);
      this.run(j)
        .catch((e) => { this.stats.failed++; log.error('research job failed', { symbol: j.symbol, err: String(e) }); })
        .finally(() => { this.active--; this.inflight.delete(j.key); this.pump(); });
    }
  }

  private deepAllowed(): boolean {
    const now = Date.now();
    this.deepTimes = this.deepTimes.filter((t) => t > now - 3600_000);
    return this.deepTimes.length < this.s.LLM_MAX_DEEP_PER_HOUR;
  }

  async run(j: Job): Promise<ResearchVerdict> {
    const cfg = this.rc.get('research');
    const pack = await buildFactPack(this.deps, { key: j.key, symbol: j.symbol, anomaly: j.anomaly });

    // Cache by (symbol, source-hash): identical inputs → reuse the verdict.
    const cached = this.db.get<{ verdict_id: string; created_at: number }>('SELECT verdict_id, created_at FROM research_cache WHERE cache_key = ?', pack.sourceHash);
    if (cached && Date.now() - cached.created_at < cfg.verdictTtlMin * 60_000 && !j.anomaly) {
      const v = this.db.get<{ body: string }>('SELECT body FROM verdicts WHERE id = ?', cached.verdict_id);
      if (v) {
        this.stats.cached++;
        const rv = JSON.parse(v.body) as ResearchVerdict;
        this.latest.set(j.key, rv);
        return rv;
      }
    }

    let run: AgentRun;
    const spent = this.llm.usageToday().costUsd;
    if (this.llm.available() && spent < this.s.LLM_MAX_USD_PER_DAY) {
      const deepAllowed = this.deepAllowed();
      run = await runCascade(this.llm, pack, {
        fastModel: this.s.LLM_FAST_MODEL, deepModel: this.s.LLM_DEEP_MODEL,
        fastTimeoutMs: this.s.LLM_FAST_TIMEOUT_MS, deepTimeoutMs: this.s.LLM_DEEP_TIMEOUT_MS,
        fastEffort: this.s.LLM_FAST_EFFORT, deepEffort: this.s.LLM_DEEP_EFFORT,
        deepAllowed, forceDeep: !!j.deep, unsureLow: this.s.LLM_UNSURE_LOW, unsureHigh: this.s.LLM_UNSURE_HIGH,
      });
      if (run.path === 'deep') this.deepTimes.push(Date.now());
    } else {
      run = runDeterministic(pack);
      if (this.llm.available()) run.trace.budget = `daily LLM spend cap $${this.s.LLM_MAX_USD_PER_DAY} reached`;
    }
    this.stats.byPath[run.path] = (this.stats.byPath[run.path] ?? 0) + 1;

    const verified = run.verdict ? verifyVerdict(run.verdict, pack) : undefined;
    const rawConf = verified?.confidence ?? 0;
    const calibrated = this.calibrator.calibrate(rawConf);
    const g = this.gate(j.key);
    const mapped = mapVerdict({
      verified, uncertain: run.uncertain || !verified, pack, anomaly: j.anomaly, calibratedConfidence: calibrated,
      isDerivative: g.isDerivative, nearBand: g.nearBand, bandLocked: g.bandLocked, minuteTurnover: g.minuteTurnover, cfg,
    });
    const now = Date.now();
    const rv: ResearchVerdict = {
      id: newId('V'),
      key: j.key,
      symbol: j.symbol,
      anomalyId: j.anomaly?.id,
      ts: now,
      path: run.path,
      proposed: run.verdict?.proposed_verdict ?? 'UNCERTAIN',
      final: mapped.final,
      causeCategory: verified?.category ?? 'unknown',
      causeSummary: run.verdict?.cause_summary ?? run.error ?? '',
      citedSourceIds: verified?.citedIds ?? [],
      droppedClaims: verified?.droppedClaims ?? 0,
      isNewInformation: verified?.isNew ?? false,
      direction: run.verdict?.direction ?? 'NONE',
      confidence: rawConf,
      calibratedConfidence: calibrated,
      expectedPersistence: run.verdict?.expected_persistence ?? 'minutes',
      unknowns: run.verdict?.unknowns ?? [],
      reasons: [...mapped.reasons, ...(verified?.notes ?? []), ...(run.error ? [`agent error: ${run.error}`] : [])],
      latencyMs: run.latencyMs + pack.buildMs,
      model: run.model,
      costUsd: run.costUsd,
      expiresAt: now + cfg.verdictTtlMin * 60_000,
    };
    const body = { ...rv, promptVersion: PROMPT_VERSION, factPack: { id: pack.id, buildMs: pack.buildMs, sources: pack.sources, pricedIn: pack.pricedIn, peers: pack.peers, move: pack.move, surveillance: pack.surveillance, sourceErrors: pack.sourceErrors }, claims: verified?.claims, trace: run.trace };
    this.db.run(
      'INSERT INTO verdicts (id, key, symbol, anomaly_id, ts, path, proposed, final, confidence, calibrated_confidence, direction, latency_ms, cost_usd, model, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      rv.id, rv.key, rv.symbol, rv.anomalyId ?? null, rv.ts, rv.path, rv.proposed, rv.final, rv.confidence, rv.calibratedConfidence, rv.direction, rv.latencyMs, rv.costUsd ?? 0, rv.model ?? null, JSON.stringify(body),
    );
    this.db.run('INSERT OR REPLACE INTO research_cache (cache_key, verdict_id, created_at) VALUES (?,?,?)', pack.sourceHash, rv.id, now);
    if (j.anomaly) this.db.run('UPDATE anomalies SET researched = 1 WHERE id = ?', j.anomaly.id);
    this.latest.set(j.key, rv);
    this.stats.completed++;
    this.bus.publish('research.verdict', rv);
    return rv;
  }

  /** Latest non-expired verdict for a key (what strategies may act on). */
  freshVerdict(key: string, now = Date.now()): ResearchVerdict | undefined {
    const v = this.latest.get(key);
    return v && v.expiresAt > now ? v : undefined;
  }

  /** BLOCK verdicts hold for the rest of the IST trading day. */
  blockedToday(key: string, now = Date.now()): boolean {
    const v = this.latest.get(key);
    if (!v || v.final !== 'BLOCK') return false;
    const d = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 10);
    return d(v.ts) === d(now);
  }

  /**
   * Label verdict outcomes 30 minutes later and refit calibration. Outcome = was the
   * directional call right? REACT: price moved in the stated direction. FADE: the
   * move reverted. Only actionable verdicts are scored.
   */
  labelOutcomes(priceAt: (key: string, ts: number) => number | undefined, now = Date.now()): { labelled: number; model?: IsotonicModel } {
    const rows = this.db.all<{ id: string; key: string; ts: number; final: string; direction: string; body: string }>(
      "SELECT id, key, ts, final, direction, body FROM verdicts WHERE outcome_correct IS NULL AND final IN ('REACT','FADE') AND ts <= ? LIMIT 500", now - 30 * 60_000,
    );
    let n = 0;
    for (const r of rows) {
      const p0 = priceAt(r.key, r.ts);
      const p1 = priceAt(r.key, r.ts + 30 * 60_000);
      if (!p0 || !p1) continue;
      const ret = Math.log(p1 / p0);
      const body = JSON.parse(r.body) as { factPack?: { move?: { retSinceStart?: number } } };
      const moveSign = Math.sign(body.factPack?.move?.retSinceStart ?? 0);
      const correct = r.final === 'REACT' ? (r.direction === 'UP' ? ret > 0 : r.direction === 'DOWN' ? ret < 0 : false) : moveSign !== 0 && Math.sign(ret) === -moveSign;
      this.db.run('UPDATE verdicts SET outcome_ret = ?, outcome_correct = ? WHERE id = ?', ret, correct ? 1 : 0, r.id);
      n++;
    }
    return { labelled: n };
  }

  refitCalibration(): IsotonicModel | undefined {
    const pts = this.db.all<{ confidence: number; outcome_correct: number }>('SELECT confidence, outcome_correct FROM verdicts WHERE outcome_correct IS NOT NULL ORDER BY ts DESC LIMIT 5000');
    if (pts.length < 10) return undefined;
    const m = fitIsotonic(pts.map((p) => ({ x: p.confidence, y: p.outcome_correct })));
    this.calibrator.set(m);
    this.db.run(
      "INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES ('calibration_model', ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      JSON.stringify(m), Date.now(),
    );
    return m;
  }

  queueDepth(): number {
    return this.queue.length + this.active;
  }
}
