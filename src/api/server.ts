// Admin API + static console. node:http with a tiny router; JSON in/out.
// Every mutating admin action is written to the hash-chained audit log.

import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../app.ts';
import { AuthService } from './auth.ts';
import { loadSettings, redactedSettings } from '../config/settings.ts';
import { SettingsStore } from '../config/settingsStore.ts';
import { recentLogs } from '../core/logger.ts';
import { sessionState, NSE_HOLIDAYS, SPECIAL_SESSIONS, CAS_LIVE_DATE, NEW_PREOPEN_DATE } from '../config/calendar.ts';
import { istParts, istDate } from '../core/clock.ts';
import { fyOf } from '../analytics/taxLedger.ts';
import type { StrategyStage } from '../core/types.ts';
import { newId } from '../core/ids.ts';
import { checkDecay } from '../ml/drift.ts';
import type { Bar } from '../core/types.ts';
import type { ValidatedRunInput, ValidatedRunOutput } from '../validation/validatedRun.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('api');
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: any; user?: string; ip: string };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; h: Handler; auth: boolean }

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const num = (v: string | null, d: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

interface BacktestJob {
  id: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export function startServer(app: App, opts: { restart?: () => Promise<void> } = {}): { close: () => Promise<void>; port: number } {
  const s = app.s;
  const auth = new AuthService(app.db, s.ADMIN_USER, s.ADMIN_PASSWORD_HASH, s.SESSION_TTL_HOURS, s.DB_PATH);
  const settingsStore = new SettingsStore(app.db, s.DB_PATH, app.audit);
  let restartPending = false;
  const routes: Route[] = [];
  const jobs = new Map<string, BacktestJob>();
  const add = (method: string, path: string, h: Handler, authRequired = true) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, h, auth: authRequired });
  };
  const book = (c: Ctx) => (c.url.searchParams.get('book') === 'live' && app.liveOms ? app.liveOms : app.paperOms);
  const actor = (c: Ctx) => c.user ?? 'unknown';

  // ---- auth -------------------------------------------------------------------
  add('POST', '/api/auth/login', (c) => {
    const r = auth.login(String(c.body.user ?? ''), String(c.body.password ?? ''), c.ip);
    if ('error' in r) {
      app.audit.append(String(c.body.user ?? '?'), 'auth.login_failed', null, { ip: c.ip });
      throw new HttpError(r.retryAfterMs ? 429 : 401, r.error);
    }
    const secure = c.req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    c.res.setHeader('Set-Cookie', `ta_session=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((r.expiresAt - Date.now()) / 1000)}${secure}`);
    app.audit.append(String(c.body.user), 'auth.login', null, { ip: c.ip });
    return { ok: true, user: c.body.user };
  }, false);
  add('POST', '/api/auth/logout', (c) => {
    auth.logout(cookies(c.req).ta_session);
    c.res.setHeader('Set-Cookie', 'ta_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  }, false);
  add('GET', '/api/auth/me', (c) => ({ user: c.user }));
  add('POST', '/api/auth/password', (c) => {
    const err = auth.changePassword(String(c.body.current ?? ''), String(c.body.next ?? ''));
    if (err) throw new HttpError(400, err);
    app.audit.append(actor(c), 'auth.password_changed', null, {});
    return { ok: true };
  });

  // ---- overview -----------------------------------------------------------------
  const overview = () => {
    const now = Date.now();
    const pf = app.livePortfolio ?? app.paperPortfolio;
    const r = pf.refresh(now);
    const paper = app.paperPortfolio.refresh(now);
    const p = istParts(now);
    return {
      now,
      ist: `${p.date} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}:${String(p.ss).padStart(2, '0')}`,
      mode: s.MODE,
      liveTradingEnabled: s.LIVE_TRADING_ENABLED,
      dataSource: s.DATA_SOURCE,
      uptimeSec: Math.round((now - app.startedAt) / 1000),
      session: { equity: sessionState(now, 'EQ_CAS'), nonCas: sessionState(now, 'EQ_NON_CAS'), fo: sessionState(now, 'FO') },
      books: {
        paper: { equity: paper.equity, drawdown: paper.drawdown, dayPnlPct: paper.dayPnlPct, cash: app.paperPortfolio.cash, realized: app.paperPortfolio.realized, unrealized: app.paperPortfolio.unrealized(), fees: app.paperPortfolio.feesPaid, openPositions: app.paperPortfolio.open().length, openRisk: app.paperPortfolio.openRisk(), grossExposure: app.paperPortfolio.grossExposure(), startingCapital: app.paperPortfolio.startingCapital },
        ...(app.livePortfolio ? { live: { equity: r.equity, drawdown: r.drawdown, dayPnlPct: r.dayPnlPct, cash: app.livePortfolio.cash, realized: app.livePortfolio.realized, unrealized: app.livePortfolio.unrealized(), fees: app.livePortfolio.feesPaid, openPositions: app.livePortfolio.open().length, openRisk: app.livePortfolio.openRisk(), grossExposure: app.livePortfolio.grossExposure(), startingCapital: app.livePortfolio.startingCapital } } : {}),
      },
      killSwitch: app.kill.get(),
      compliance: app.compliance.status(),
      reconcile: { paper: { ok: app.paperOms.reconciled, last: app.paperOms.lastReconcile }, live: app.liveOms ? { ok: app.liveOms.reconciled, last: app.liveOms.lastReconcile } : undefined },
      loop: app.loop.stats,
      scanner: app.scanner.stats,
      research: { ...app.research.stats, queue: app.research.queueDepth(), llmAvailable: app.llm.available(), usage: app.llm.usageToday(), fastModel: s.LLM_FAST_MODEL, deepModel: s.LLM_DEEP_MODEL },
      surveillance: app.surveillance.getStatus(),
      feed: app.feed?.status(),
      sweeper: app.sweeper ? { sweeps: app.sweeper.sweeps, errors: app.sweeper.errors, lastSweepMs: app.sweeper.lastSweepMs } : undefined,
      throttle: { currentOps: app.throttle.currentOps(), peakOps: app.throttle.peakOps, rejected: app.throttle.rejected, hardLimit: app.throttle.hardLimit, alertAt: app.throttle.alertAt },
      oms: { paper: app.paperOms.stats, live: app.liveOms?.stats },
      clock: { skewMs: app.skew.skewMs(), medianTickLagMs: app.staleness.medianLagMs() },
      ticks: app.ticks,
      freakDropped: app.freakDropped,
      instruments: app.refdata.size(),
      bus: app.bus.stats(),
      breakers: app.risk.strategyBreakers(),
      metaModel: app.metaModel ? { trainedAt: app.metaModel.trainedAt, nTrain: app.metaModel.nTrain } : null,
    };
  };
  add('GET', '/api/overview', () => overview());

  // ---- market / instruments ------------------------------------------------------
  add('GET', '/api/instruments', (c) => {
    const q = (c.url.searchParams.get('q') ?? '').toUpperCase();
    return app.refdata.all().filter((i) => !q || i.symbol.includes(q)).slice(0, 200).map((i) => {
      const st = app.quotes.get(i.key);
      return { ...i, ltp: st?.last?.ltp, prevClose: st?.prevClose, changePct: st?.last && st.prevClose ? (st.last.ltp / st.prevClose - 1) * 100 : undefined, stale: app.staleness.isStale(i.key, Date.now()), tier: app.scanner.stateOf(i.key).tier, band: st?.band };
    });
  });
  add('GET', '/api/bars/:key', (c) => app.quotes.bars(decodeURIComponent(c.params.key), num(c.url.searchParams.get('n'), 240)));

  // ---- trading -------------------------------------------------------------------
  const posView = (oms: typeof app.paperOms) => oms.portfolio.open().map((p) => {
    const ltp = app.quotes.ltp(p.instrumentKey);
    const inst = app.refdata.byKey(p.instrumentKey);
    return { ...p, symbol: inst?.symbol, ltp, unrealized: ltp !== undefined ? (ltp - p.avgPrice) * p.qty : undefined, book: oms.mode };
  });
  add('GET', '/api/positions', () => [...posView(app.paperOms), ...(app.liveOms ? posView(app.liveOms) : [])]);
  add('POST', '/api/positions/exit', async (c) => {
    const oms = c.body.book === 'live' && app.liveOms ? app.liveOms : app.paperOms;
    app.audit.append(actor(c), 'position.manual_exit', c.body.instrumentKey, { strategyId: c.body.strategyId, book: oms.mode });
    const o = await oms.exitPosition(String(c.body.instrumentKey), String(c.body.strategyId), `manual exit by ${actor(c)}`);
    return { ok: !!o, order: o };
  });
  add('GET', '/api/orders', (c) => book(c).recentOrders(num(c.url.searchParams.get('limit'), 200)));
  add('POST', '/api/orders/:id/cancel', async (c) => {
    app.audit.append(actor(c), 'order.manual_cancel', c.params.id, {});
    await book(c).cancel(c.params.id, `manual cancel by ${actor(c)}`);
    return { ok: true };
  });
  add('GET', '/api/fills', (c) => app.db.all('SELECT * FROM fills WHERE mode = ? ORDER BY ts DESC LIMIT ?', book(c).mode, num(c.url.searchParams.get('limit'), 200)));
  add('GET', '/api/trades', (c) => book(c).portfolio.closedTrades.slice(-500).reverse());
  add('GET', '/api/signals', (c) => {
    const d = c.url.searchParams.get('decision');
    const rows = d
      ? app.db.all<Record<string, any>>('SELECT * FROM signals WHERE decision = ? ORDER BY ts DESC LIMIT ?', d, num(c.url.searchParams.get('limit'), 200))
      : app.db.all<Record<string, any>>('SELECT * FROM signals ORDER BY ts DESC LIMIT ?', num(c.url.searchParams.get('limit'), 200));
    return rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasons ?? '[]'), symbol: app.refdata.byKey(r.instrument_key)?.symbol }));
  });
  add('GET', '/api/equity', (c) => app.db.all('SELECT ts, equity, cash, open_risk, gross_exposure FROM equity_curve WHERE mode = ? AND ts >= ? ORDER BY ts', book(c).mode, num(c.url.searchParams.get('since'), Date.now() - 7 * 86400_000)));

  // ---- risk controls -------------------------------------------------------------
  add('POST', '/api/killswitch', async (c) => {
    if (c.body.engage) {
      app.kill.engage(String(c.body.reason || 'manual'), actor(c));
      if (c.body.flatten) {
        await app.paperOms.flattenAll('kill switch flatten');
        if (app.liveOms) await app.liveOms.flattenAll('kill switch flatten');
      }
    } else {
      if (!c.body.reason || String(c.body.reason).trim().length < 5) throw new HttpError(400, 'a note (>= 5 chars) is required to disengage');
      app.kill.disengage(actor(c), String(c.body.reason));
    }
    return app.kill.get();
  });
  add('POST', '/api/flatten', async (c) => {
    app.audit.append(actor(c), 'flatten.all', null, { book: c.body.book ?? 'paper', reason: c.body.reason });
    await (c.body.book === 'live' && app.liveOms ? app.liveOms : app.paperOms).flattenAll(`manual flatten by ${actor(c)}`);
    return { ok: true };
  });
  add('GET', '/api/config', () => app.rc.all());
  add('PUT', '/api/config/:name', (c) => {
    const name = c.params.name as 'risk' | 'scanner' | 'research';
    if (!['risk', 'scanner', 'research'].includes(name)) throw new HttpError(404, 'unknown config');
    try {
      return app.rc.update(name, c.body, actor(c));
    } catch (e) {
      throw new HttpError(400, String((e as Error).message));
    }
  });
  // ---- console-managed settings (API keys etc.) ---------------------------------
  add('GET', '/api/settings', () => ({
    fields: settingsStore.view(),
    restartPending,
    canRestart: !!opts.restart,
    running: redactedSettings(s),
    dbPath: s.DB_PATH,
  }));
  add('PUT', '/api/settings', (c) => {
    try {
      const r = settingsStore.save(c.body.values ?? {}, actor(c), c.body.confirmation);
      if (r.changed.length) restartPending = true;
      return { ...r, restartPending };
    } catch (e) {
      throw new HttpError(400, String((e as Error).message));
    }
  });
  add('POST', '/api/system/restart', (c) => {
    if (!opts.restart) throw new HttpError(400, 'restart not available in this process');
    app.audit.append(actor(c), 'system.restart', null, {});
    setTimeout(() => void opts.restart!(), 300);
    return { ok: true, port: loadSettings(process.env, undefined, settingsStore.overrides()).PORT };
  });
  add('POST', '/api/settings/test/:target', async (c) => {
    // Tests use the SAVED values (even before restart), so keys can be checked first.
    const eff = loadSettings(process.env, undefined, settingsStore.overrides());
    const t = c.params.target;
    const timeout = AbortSignal.timeout(10_000);
    try {
      if (t === 'openai') {
        if (!eff.OPENAI_API_KEY) return { ok: false, message: 'No OpenAI API key saved' };
        const res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(eff.LLM_FAST_MODEL)}`, { headers: { Authorization: `Bearer ${eff.OPENAI_API_KEY}` }, signal: timeout });
        const res2 = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(eff.LLM_DEEP_MODEL)}`, { headers: { Authorization: `Bearer ${eff.OPENAI_API_KEY}` }, signal: timeout });
        if (res.status === 401) return { ok: false, message: 'OpenAI rejected the key (401)' };
        return { ok: res.ok && res2.ok, message: `key accepted · ${eff.LLM_FAST_MODEL}: ${res.ok ? 'available' : `HTTP ${res.status}`} · ${eff.LLM_DEEP_MODEL}: ${res2.ok ? 'available' : `HTTP ${res2.status}`}` };
      }
      if (t === 'telegram') {
        if (!eff.TELEGRAM_BOT_TOKEN || !eff.TELEGRAM_CHAT_ID) return { ok: false, message: 'Bot token and chat id are both required' };
        const res = await fetch(`https://api.telegram.org/bot${eff.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: eff.TELEGRAM_CHAT_ID, text: 'TradeAI test alert ✅' }), signal: timeout });
        return { ok: res.ok, message: res.ok ? 'Test message sent' : `Telegram returned HTTP ${res.status}` };
      }
      if (t === 'upstox') {
        if (!eff.UPSTOX_API_KEY || !eff.UPSTOX_API_SECRET || !eff.UPSTOX_REDIRECT_URI) return { ok: false, message: 'API key, secret and redirect URI are required' };
        if (!eff.UPSTOX_ALGO_NAME) return { ok: false, message: 'Credentials saved, but Algo Name is missing (orders would be rejected)' };
        if (!app.upstox?.hasToken()) return { ok: true, message: 'Credentials saved. Restart, then complete the daily login on the Compliance page to verify them.' };
        const pos = await app.upstox.getPositions().then(() => true).catch(() => false);
        return { ok: pos, message: pos ? 'Upstox session is active and the API responds' : 'Upstox session token was rejected; log in again from the Compliance page' };
      }
      if (t === 'delta') {
        const res = await fetch(`${eff.DELTA_BASE_URL.replace(/\/$/, '')}/v2/products?contract_types=perpetual_futures`, { signal: timeout });
        if (!res.ok) return { ok: false, message: `Delta returned HTTP ${res.status}` };
        return { ok: true, message: eff.DELTA_API_KEY ? 'Delta reachable; key saved (verified on first signed call after restart)' : 'Delta reachable; no API key saved yet' };
      }
      if (t === 'ip') {
        const res = await fetch(eff.EGRESS_IP_CHECK_URL, { signal: timeout });
        const ip = (await res.text()).trim();
        const match = ip === eff.STATIC_IP_PRIMARY || ip === eff.STATIC_IP_SECONDARY;
        return { ok: match, message: `This server's egress IP is ${ip}${match ? ' (registered)' : ' — not one of the saved static IPs'}` };
      }
      throw new HttpError(404, 'unknown test');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return { ok: false, message: `Connection failed: ${String((e as Error).message ?? e)}` };
    }
  });
  add('POST', '/api/paper/reset', (c) => {
    const cap = Number(c.body.capital ?? s.CAPITAL_INR);
    if (!(cap > 0)) throw new HttpError(400, 'capital must be > 0');
    if (app.paperPortfolio.open().length) throw new HttpError(409, 'flatten paper positions first');
    app.paperPortfolio.reset(cap);
    app.audit.append(actor(c), 'paper.reset', null, { capital: cap });
    return { ok: true };
  });

  // ---- strategies ------------------------------------------------------------------
  add('GET', '/api/strategies', () => {
    const shadow = app.shadow.stats();
    const trades = app.paperPortfolio.closedTrades;
    return app.strategies.list().map((st) => {
      const t = trades.filter((x) => x.strategyId === st.id);
      const latestTrial = app.trials.list(1, st.id)[0];
      return {
        ...st,
        paper: { trades: t.length, netPnl: t.reduce((a, x) => a + x.netPnl, 0), winRate: t.length ? t.filter((x) => x.netPnl > 0).length / t.length : 0 },
        shadow: shadow[st.id],
        latestTrial: latestTrial ? { id: latestTrial.id, ts: latestTrial.ts, passed: latestTrial.passed, dsr: latestTrial.dsr, pbo: latestTrial.pbo, sharpe: latestTrial.sharpe } : null,
        paused: app.risk.strategyPaused(st.id, istDate(Date.now())),
      };
    });
  });
  add('POST', '/api/strategies/:id/stage', (c) => {
    const stage = String(c.body.stage) as StrategyStage;
    if (!['disabled', 'shadow', 'paper', 'live'].includes(stage)) throw new HttpError(400, 'invalid stage');
    try {
      app.strategies.setStage(c.params.id, stage, actor(c), c.body.justification);
    } catch (e) {
      throw new HttpError(400, String((e as Error).message));
    }
    return { ok: true };
  });
  add('GET', '/api/drift', () => {
    return app.strategies.list().map((st) => {
      const live = app.paperPortfolio.closedTrades.filter((t) => t.strategyId === st.id).map((t) => t.netPnl / app.paperPortfolio.startingCapital);
      const trial = app.trials.list(1, st.id)[0];
      const btSharpe = trial?.sharpe ?? 0;
      const btExp = Number(trial?.metrics?.expectancyPerTradeFrac ?? 0);
      return { strategyId: st.id, ...checkDecay(live, btSharpe, btExp) };
    });
  });

  // ---- scanner & research -------------------------------------------------------------
  add('GET', '/api/anomalies', (c) => {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const type = c.url.searchParams.get('type');
    if (type) { where.push('type = ?'); params.push(type); }
    const minSev = c.url.searchParams.get('minSeverity');
    if (minSev) { where.push('severity >= ?'); params.push(Number(minSev)); }
    const sym = c.url.searchParams.get('symbol');
    if (sym) { where.push('symbol = ?'); params.push(sym.toUpperCase()); }
    if (c.url.searchParams.get('hideSuppressed') === '1') where.push('suppressed = 0');
    const rows = app.db.all<Record<string, any>>(`SELECT * FROM anomalies ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`, ...params, num(c.url.searchParams.get('limit'), 200));
    return rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  });
  add('GET', '/api/anomalies/stats', () => app.db.all(`SELECT type, COUNT(*) AS n, AVG(severity) AS avgSeverity,
      AVG(CASE WHEN fwd_ret_5m IS NOT NULL THEN fwd_ret_5m END) AS avgFwd5m, AVG(CASE WHEN fwd_ret_30m IS NOT NULL THEN fwd_ret_30m END) AS avgFwd30m,
      SUM(CASE WHEN fwd_ret_30m IS NOT NULL THEN 1 ELSE 0 END) AS labelled, SUM(suppressed) AS suppressed FROM anomalies GROUP BY type ORDER BY n DESC`));
  add('GET', '/api/verdicts', (c) => app.db.all<Record<string, any>>('SELECT id, key, symbol, anomaly_id, ts, path, proposed, final, confidence, calibrated_confidence, direction, latency_ms, cost_usd, model, outcome_ret, outcome_correct FROM verdicts ORDER BY ts DESC LIMIT ?', num(c.url.searchParams.get('limit'), 100)));
  add('GET', '/api/verdicts/:id', (c) => {
    const r = app.db.get<{ body: string; outcome_ret: number | null; outcome_correct: number | null }>('SELECT body, outcome_ret, outcome_correct FROM verdicts WHERE id = ?', c.params.id);
    if (!r) throw new HttpError(404, 'not found');
    return { ...JSON.parse(r.body), outcomeRet: r.outcome_ret, outcomeCorrect: r.outcome_correct };
  });
  add('POST', '/api/research', (c) => {
    const inst = app.refdata.bySymbol(String(c.body.symbol ?? '').toUpperCase()) ?? app.refdata.byKey(String(c.body.key ?? ''));
    if (!inst) throw new HttpError(404, 'unknown symbol');
    app.audit.append(actor(c), 'research.manual', inst.key, { deep: !!c.body.deep });
    app.bus.publish('research.request', { key: inst.key, symbol: inst.symbol, reason: 'manual', deep: !!c.body.deep });
    return { ok: true, queued: inst.symbol };
  });
  add('GET', '/api/research/calibration', () => {
    const rows = app.db.all<{ confidence: number; outcome_correct: number }>('SELECT confidence, outcome_correct FROM verdicts WHERE outcome_correct IS NOT NULL');
    const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, hits: 0 }));
    for (const r of rows) {
      const b = bins[Math.min(9, Math.floor(r.confidence * 10))];
      b.n++;
      b.hits += r.outcome_correct;
    }
    return { model: app.research.calibrator.get() ?? null, bins, labelled: rows.length };
  });
  add('POST', '/api/research/calibration/refit', (c) => {
    const m = app.research.refitCalibration();
    app.audit.append(actor(c), 'research.calibration_refit', null, { n: m?.n });
    return { ok: !!m, model: m ?? null };
  });

  // ---- surveillance & compliance ---------------------------------------------------------
  add('GET', '/api/surveillance', (c) => ({ status: app.surveillance.getStatus(), rows: app.surveillance.list(c.url.searchParams.get('filter') === 'all' ? 'all' : 'restricted', 1000), deals: app.surveillance.recentDeals().slice(0, 200) }));
  add('POST', '/api/surveillance/refresh', async (c) => {
    app.audit.append(actor(c), 'surveillance.refresh', null, {});
    await app.surveillance.refreshFromNse();
    return app.surveillance.getStatus();
  });
  add('POST', '/api/surveillance/upload', (c) => {
    const files: Record<string, string> = {};
    for (const k of ['secList', 'foSecBan', 'regInd', 'bulk', 'block']) if (typeof c.body[k] === 'string' && c.body[k].length) files[k] = c.body[k];
    if (!Object.keys(files).length) throw new HttpError(400, 'no files');
    try {
      app.surveillance.apply(files, `manual upload by ${actor(c)}`);
    } catch (e) {
      throw new HttpError(400, String((e as Error).message));
    }
    app.audit.append(actor(c), 'surveillance.upload', null, { files: Object.keys(files) });
    return app.surveillance.getStatus();
  });
  // OAuth: the Upstox redirect is a cross-site navigation, so the SameSite=Strict session
  // cookie is not sent. The callback is therefore authenticated by a one-time random
  // `state` issued to a signed-in admin (10-minute expiry).
  const oauthStates = new Map<string, number>();
  add('GET', '/api/compliance', () => {
    let upstoxLoginUrl: string | undefined;
    if (s.UPSTOX_API_KEY && s.UPSTOX_REDIRECT_URI && app.upstox) {
      const st = randomBytes(16).toString('hex');
      oauthStates.set(st, Date.now() + 10 * 60_000);
      for (const [k, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(k);
      upstoxLoginUrl = app.upstox.loginUrl(st);
    }
    return { ...app.compliance.status(), lastPaperHeaders: app.paperBroker.lastOrderHeaders(), lastLiveHeaders: app.upstox?.lastOrderHeaders(), upstoxLoginUrl };
  });
  add('POST', '/api/compliance/check-ip', async () => {
    await app.compliance.checkEgressIp();
    return app.compliance.status();
  });
  add('GET', '/api/upstox/callback', async (c) => {
    const code = c.url.searchParams.get('code');
    const st = c.url.searchParams.get('state') ?? '';
    const exp = oauthStates.get(st);
    oauthStates.delete(st);
    if (!exp || exp < Date.now()) throw new HttpError(403, 'invalid or expired OAuth state; start the login from the Compliance page');
    if (!code || !app.upstox) throw new HttpError(400, 'missing code or Upstox not configured');
    await app.upstox.exchangeCode(code);
    await app.onUpstoxLogin();
    app.audit.append('admin', 'upstox.oauth_callback', null, { ip: c.ip });
    c.res.writeHead(302, { Location: '/#/compliance' });
    c.res.end();
    return undefined;
  }, false);
  add('POST', '/api/reconcile/run', async (c) => {
    const r = await book(c).reconcile();
    return r;
  });
  add('POST', '/api/reconcile/ack', (c) => {
    if (!c.body.note || String(c.body.note).length < 5) throw new HttpError(400, 'note required');
    book(c).acknowledgeReconcile(actor(c), String(c.body.note));
    return { ok: true };
  });
  add('GET', '/api/calendar', () => ({ holidays: NSE_HOLIDAYS, special: SPECIAL_SESSIONS, casLiveDate: CAS_LIVE_DATE, newPreopenDate: NEW_PREOPEN_DATE, today: istDate(Date.now()), phases: { casEq: sessionState(Date.now(), 'EQ_CAS'), nonCasEq: sessionState(Date.now(), 'EQ_NON_CAS'), fo: sessionState(Date.now(), 'FO') } }));

  // ---- validation / backtests ----------------------------------------------------------------
  add('GET', '/api/validation/trials', (c) => app.trials.list(num(c.url.searchParams.get('limit'), 100), c.url.searchParams.get('strategy') ?? undefined));
  add('GET', '/api/backtests', () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((j) => ({ ...j, result: j.status === 'done' ? { metrics: (j.result as any)?.metrics, gate: (j.result as any)?.gate } : undefined })));
  add('GET', '/api/backtests/:id', (c) => {
    const j = jobs.get(c.params.id);
    if (!j) throw new HttpError(404, 'not found');
    return j;
  });
  add('POST', '/api/backtests', (c) => {
    const days = Math.min(Math.max(num(String(c.body.days ?? ''), 15), 5), 60);
    const strategyId = String(c.body.strategy ?? 'all');
    const nInst = Math.min(Math.max(num(String(c.body.instruments ?? ''), 12), 3), 40);
    const source = c.body.source === 'db' ? 'db' : 'synthetic';
    const id = newId('BT');
    const job: BacktestJob = { id, status: 'running', startedAt: Date.now(), params: { days, strategyId, nInst, source } };
    jobs.set(id, job);
    app.audit.append(actor(c), 'backtest.start', id, job.params);
    void (async () => {
      try {
        job.result = await runValidatedBacktest(app, { days, strategyId, nInst, source });
        job.status = 'done';
      } catch (e) {
        job.status = 'error';
        job.error = String((e as Error).message ?? e);
        log.error('backtest failed', { err: String((e as Error).stack ?? e) });
      }
    })();
    return { id };
  });
  add('GET', '/api/tax', (c) => {
    const fy = c.url.searchParams.get('fy') ?? fyOf(Date.now());
    return { fy, fys: app.tax.fys(), mode: book(c).mode, rows: app.tax.summary(fy, book(c).mode) };
  });

  // ---- governance / ops -------------------------------------------------------------------------
  add('GET', '/api/audit', (c) => app.audit.list({ limit: num(c.url.searchParams.get('limit'), 100), before: num(c.url.searchParams.get('before'), 0) || undefined, action: c.url.searchParams.get('action') ?? undefined }));
  add('GET', '/api/audit/verify', () => app.audit.verify());
  add('GET', '/api/logs', (c) => recentLogs(num(c.url.searchParams.get('limit'), 300), (c.url.searchParams.get('level') as any) ?? undefined));
  add('GET', '/api/events', (c) => {
    const t = c.url.searchParams.get('topic') as any;
    return t ? app.bus.history(t, num(c.url.searchParams.get('limit'), 100)) : [];
  });
  add('GET', '/api/health', () => ({ ok: true, ts: Date.now(), kill: app.kill.engaged(), uptimeSec: Math.round((Date.now() - app.startedAt) / 1000) }), false);
  add('GET', '/metrics', (c) => {
    if (!c.user && c.ip !== '127.0.0.1' && c.ip !== '::1' && c.ip !== '::ffff:127.0.0.1') throw new HttpError(401, 'unauthorised');
    app.updateMetrics();
    c.res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    c.res.end(app.metrics.render());
    return undefined;
  }, false);

  // SSE stream: bus events + an overview snapshot every 2 s.
  add('GET', '/api/stream', (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('overview', overview());
    const off = app.bus.onAny((env) => send(env.topic, env.data));
    const t = setInterval(() => send('overview', overview()), 2000);
    c.req.on('close', () => { off(); clearInterval(t); });
    return undefined;
  });

  // ---- server ------------------------------------------------------------------------------------
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = req.socket.remoteAddress ?? '?';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/metrics') return await serveStatic(url.pathname, res);
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new HttpError(404, 'not found');
      const m = url.pathname.match(route.re)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const sess = auth.session(cookies(req).ta_session);
      if (route.auth && !sess) throw new HttpError(401, 'login required');
      if (req.method !== 'GET' && route.auth && req.headers['x-requested-with'] !== 'tradeai') throw new HttpError(403, 'missing X-Requested-With header');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await route.h({ req, res, url, params, body, user: sess?.user, ip });
      if (out !== undefined && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error('request failed', { path: url.pathname, err: String((e as Error)?.stack ?? e) });
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'internal error' }));
      }
    }
  });
  server.listen(s.PORT, s.HOST);
  log.info('admin console listening', { url: `http://${s.HOST}:${s.PORT}` });
  return {
    close: () => new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections(); // SSE streams would otherwise keep the server open
    }),
    port: s.PORT,
  };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(normalize(PUBLIC_DIR))) throw new HttpError(403, 'forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
    res.end(data);
  } catch {
    const data = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(data);
  }
}

/**
 * Backtest + validation stack, executed in a worker thread so the trading loop is
 * never blocked. The worker returns results; the trial is recorded here.
 */
async function runValidatedBacktest(app: App, p: { days: number; strategyId: string; nInst: number; source: 'synthetic' | 'db' }) {
  const insts = app.refdata.all().filter((i) => i.type === 'EQ' || i.type === 'INDEX').slice(0, p.nInst + 1);
  let bars: [string, Bar[]][] | undefined;
  if (p.source === 'db') {
    bars = [];
    const since = Date.now() - p.days * 86400_000 * 1.6;
    for (const i of insts) {
      const rows = app.db.all<{ ts: number; o: number; h: number; l: number; c: number; v: number; oi: number | null }>('SELECT ts, o, h, l, c, v, oi FROM bars WHERE key = ? AND ts >= ? ORDER BY ts', i.key, since);
      if (rows.length) bars.push([i.key, rows.map((r) => ({ key: i.key, ts: r.ts, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, oi: r.oi ?? undefined }))]);
    }
    if (!bars.length) throw new Error('no stored bars for these instruments');
  }
  const familyId = p.strategyId === 'all' ? 'ensemble' : p.strategyId;
  const input: ValidatedRunInput = {
    instruments: insts, bars, days: p.days, endDate: istDate(Date.now() - 86400_000), seed: Date.now() % 1000,
    strategyId: p.strategyId, capital: app.paperPortfolio.startingCapital, risk: app.rc.get('risk'),
    priorTrialSharpes: app.trials.trialSharpes(familyId),
  };
  const out = await new Promise<ValidatedRunOutput>((resolve, reject) => {
    const w = new Worker(new URL('../validation/validationWorker.ts', import.meta.url), { workerData: input });
    w.once('message', (m: { ok: boolean; result?: ValidatedRunOutput; error?: string }) => (m.ok ? resolve(m.result!) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`validation worker exited with ${code}`)); });
  });
  const trial = app.trials.record({
    strategyId: familyId,
    hypothesis: `${p.source} ${p.days}d validation run from admin console`,
    params: out.params,
    dataRange: { from: out.dailyDates[0], to: out.dailyDates[out.dailyDates.length - 1], universe: `${insts.length} instruments (${p.source})` },
    metrics: { ...out.metrics, expectancyPerTradeFrac: out.metrics.expectancy / input.capital, doubledSlippageSharpe: out.doubledSlippage.dailySharpe } as any,
    sharpe: out.metrics.dailySharpe,
    nObs: out.dailyReturns.length,
    dsr: out.dsr.dsr,
    pbo: out.pbo,
    passed: out.gate.passed,
    gateReport: out.gate,
  });
  return {
    ...out,
    trialId: trial.id,
    source: p.source,
    warning: p.source === 'synthetic' ? 'Synthetic random-walk data has no edge by construction; use this to exercise the validation pipeline, not to judge strategies.' : undefined,
  };
}
