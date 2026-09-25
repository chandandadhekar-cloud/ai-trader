// Market-wide anomaly scanner (plan §B). Runs independently of the 1-minute
// decision loop. Bars are buffered per minute and the whole cross-section is
// processed once the minute is complete (sector averages need every member),
// and a 1-second pass checks live prices against the last bar close.
//
// Detectors: volatility-adjusted return shock (time-of-day adjusted), cumulative
// RVOL vs the same time of day over 20 sessions, short-window volume bursts,
// sector-relative residual, index shock (macro path), opening gap vs index,
// band proximity/hit, OI spike with build-up quadrant, IV jump, CUSUM and BOCPD
// change points. Every anomaly is logged (including suppressed ones) and later
// labelled with forward returns: that dataset is the research asset.

import type { Anomaly, AnomalyType, Bar, Instrument, Tick } from '../core/types.ts';
import type { EventBus } from '../core/events.ts';
import type { Db } from '../db/database.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { ScannerConfig } from '../config/runtime.ts';
import { newId } from '../core/ids.ts';
import { istDate } from '../core/clock.ts';
import { minutesSinceOpen } from '../config/calendar.ts';
import { Ewma, median } from './stats.ts';
import { Bocpd, Cusum } from './changepoint.ts';
import { VolatilityProfile, VolumeProfile } from './intradayProfiles.ts';
import { buildup, depthImbalance, imbalance, severity } from './scorer.ts';
import { bandDistance } from '../surveillance/bands.ts';
import { beta as olsBeta } from '../features/technical.ts';

interface SymState {
  inst: Instrument;
  tier: Anomaly['tier'];
  normVar: Ewma; // EWMA of r1 / profile factor
  resid: Ewma;
  dOi: Ewma;
  dIv: Ewma;
  cusum: Cusum;
  bocpd: Bocpd;
  vol: VolumeProfile;
  closes: number[];
  rets: number[];
  sectorRets: number[];
  idxRets: number[];
  barVols: number[];
  cumVol: number;
  cumDate?: string;
  dayOpen?: number;
  lastOi?: number;
  lastIv?: number;
  lastClose?: number;
  gapChecked?: string;
  lastFired: Map<AnomalyType, number>;
}

export interface ScannerStats {
  symbols: number;
  processedMinutes: number;
  anomalies: number;
  suppressed: number;
  lastRunMs: number;
  byType: Record<string, number>;
}

const HIST = 240;

export class Scanner {
  private states = new Map<string, SymState>();
  private pending = new Map<number, Bar[]>();
  private volProfile = new VolatilityProfile();
  private bus: EventBus;
  private db: Db;
  private quotes: QuoteBook;
  private cfg: () => ScannerConfig;
  private indexKey?: string;
  private now: () => number;
  stats: ScannerStats = { symbols: 0, processedMinutes: 0, anomalies: 0, suppressed: 0, lastRunMs: 0, byType: {} };
  private lastIndexRet5 = 0;
  private lastIndexGapPct = 0;

  constructor(opts: { bus: EventBus; db: Db; quotes: QuoteBook; cfg: () => ScannerConfig; indexKey?: string; now?: () => number }) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.quotes = opts.quotes;
    this.cfg = opts.cfg;
    this.indexKey = opts.indexKey;
    this.now = opts.now ?? Date.now;
  }

  register(inst: Instrument, tier: Anomaly['tier']): void {
    const existing = this.states.get(inst.key);
    if (existing) { existing.tier = tier; return; }
    this.states.set(inst.key, {
      inst, tier,
      normVar: new Ewma(0.03), resid: new Ewma(0.03), dOi: new Ewma(0.05), dIv: new Ewma(0.05),
      cusum: new Cusum(0.5, 6), bocpd: new Bocpd(1 / 300, 240),
      vol: new VolumeProfile(20),
      closes: [], rets: [], sectorRets: [], idxRets: [], barVols: [], cumVol: 0,
      lastFired: new Map(),
    });
    this.stats.symbols = this.states.size;
  }

  setTier(key: string, tier: Anomaly['tier']): void {
    const s = this.states.get(key);
    if (s) s.tier = tier;
  }

  onBar(b: Bar): void {
    if (!this.states.has(b.key)) return;
    let l = this.pending.get(b.ts);
    if (!l) this.pending.set(b.ts, (l = []));
    l.push(b);
  }

  /** Process every buffered minute that is complete (ts + 60s + grace <= now). */
  processReady(now = this.now(), graceMs = 2000): void {
    const ready = [...this.pending.keys()].filter((ts) => ts + 60_000 + graceMs <= now).sort((a, b) => a - b);
    for (const ts of ready) {
      const bars = this.pending.get(ts)!;
      this.pending.delete(ts);
      this.processMinute(ts, bars);
    }
  }

  processMinute(ts: number, bars: Bar[]): Anomaly[] {
    const t0 = performance.now();
    const cfg = this.cfg();
    const out: Anomaly[] = [];
    const mso = minutesSinceOpen(ts);
    const prof = this.volProfile.factor(mso);
    const date = istDate(ts);

    // Pass 1: returns and sector averages.
    const r1 = new Map<string, number>();
    for (const b of bars) {
      const s = this.states.get(b.key)!;
      if (s.lastClose && s.lastClose > 0 && b.close > 0) r1.set(b.key, Math.log(b.close / s.lastClose));
    }
    const sectorSum = new Map<string, { s: number; n: number }>();
    for (const [k, r] of r1) {
      const sec = this.states.get(k)!.inst.sector;
      if (!sec) continue;
      const v = sectorSum.get(sec) ?? { s: 0, n: 0 };
      v.s += r;
      v.n++;
      sectorSum.set(sec, v);
    }
    const idxR = this.indexKey ? r1.get(this.indexKey) ?? 0 : 0;
    // Index 5-minute return and opening gap must be known before any stock is scored.
    const idxBar = this.indexKey ? bars.find((b) => b.key === this.indexKey) : undefined;
    if (idxBar) {
      const is = this.states.get(idxBar.key)!;
      if (is.closes.length >= 5) this.lastIndexRet5 = Math.log(idxBar.close / is.closes[is.closes.length - 5]);
      const pc = q_prevClose(this.quotes, idxBar.key);
      if (mso >= 0 && mso < 2 && pc) this.lastIndexGapPct = Math.log(idxBar.open / pc);
    }

    // Pass 2: detectors.
    for (const b of bars) {
      const s = this.states.get(b.key)!;
      if (s.cumDate !== date) {
        s.cumDate = date;
        s.cumVol = 0;
        s.dayOpen = b.open;
      }
      s.cumVol += b.volume;
      s.vol.observe(date, mso, s.cumVol);
      const r = r1.get(b.key);
      const isIndex = b.key === this.indexKey;
      if (r !== undefined) {
        const sig = Math.sqrt(s.normVar.var);
        const ready = s.normVar.n >= 30 && sig > 0;
        const z1 = ready ? r / (sig * prof) : undefined;
        const r5 = s.closes.length >= 5 ? Math.log(b.close / s.closes[s.closes.length - 5]) : undefined;
        const z5 = ready && r5 !== undefined ? r5 / (sig * prof * Math.sqrt(5)) : undefined;
        const zOpen = ready && s.dayOpen ? Math.log(b.close / s.dayOpen) / (sig * Math.sqrt(Math.max(mso, 1))) : undefined;

        // Sector-relative residual (leave-one-out sector mean; index when sector too small).
        const sec = s.inst.sector ? sectorSum.get(s.inst.sector) : undefined;
        const secR = sec && sec.n >= 3 ? (sec.s - r) / (sec.n - 1) : idxR;
        s.sectorRets.push(secR);
        s.idxRets.push(idxR);
        s.rets.push(r);
        if (s.rets.length > HIST) { s.rets.shift(); s.sectorRets.shift(); s.idxRets.shift(); }
        const bSec = olsBeta(s.rets.slice(0, -1), s.sectorRets.slice(0, -1)) ?? 1;
        const bIdx = olsBeta(s.rets.slice(0, -1), s.idxRets.slice(0, -1)) ?? 1;
        const residual = r - bSec * secR;
        // Residual z only after the residual variance has a real history (avoids warm-up noise).
        const rz = s.resid.n >= 60 ? s.resid.z(residual) : undefined;

        // Share of the 5-minute move explained by the index.
        const explained = r5 && !isIndex ? (bIdx * this.lastIndexRet5) / r5 : 0;
        const indexDriven = explained > cfg.indexExplainedSuppress;

        const q = this.quotes.get(b.key);
        const imb = imbalance(q?.last?.tbq, q?.last?.tsq);
        const dimb = depthImbalance(q?.last?.depth);
        const vols = s.barVols.slice(-60);
        const turnover = (median(vols) ?? b.volume) * b.close;
        const rvol = s.vol.rvol(mso, s.cumVol);
        // Short-window burst: last 5 bars vs median 5-bar volume over the prior 2 hours.
        let burst: number | undefined;
        if (s.barVols.length >= 35) {
          const last5 = s.barVols.slice(-4).reduce((a, v) => a + v, 0) + b.volume;
          const windows: number[] = [];
          const hist = s.barVols.slice(-120, -4);
          for (let i = 0; i + 5 <= hist.length; i += 5) windows.push(hist.slice(i, i + 5).reduce((a, v) => a + v, 0));
          const m = median(windows);
          if (m && m > 0) burst = last5 / m;
        }
        const common = { z: z5 !== undefined && Math.abs(z5) > Math.abs(z1 ?? 0) ? z5 : z1, rvol: rvol ?? burst, residualZ: rz, price: b.close, ret: r5 ?? r };
        const details = { z1, z5, zOpen, r1: r, r5, betaSector: bSec, betaIndex: bIdx, sectorRet: secR, indexRet5: this.lastIndexRet5, explainedByIndex: explained, rvolCum: rvol, volBurst5m: burst, imbalance: imb, depthImbalance: dimb, minuteTurnover: turnover, profileFactor: prof };

        if (isIndex) {
          if (z1 !== undefined && (Math.abs(z1) >= cfg.zThreshold || (z5 !== undefined && Math.abs(z5) >= cfg.zThreshold))) {
            out.push(this.fire(s, 'INDEX_SHOCK', ts, { ...common, turnover: undefined }, details, false));
          }
        } else {
          if ((z1 !== undefined && Math.abs(z1) >= cfg.zThreshold) || (z5 !== undefined && Math.abs(z5) >= cfg.zThreshold)) {
            out.push(this.fire(s, 'RETURN_SHOCK', ts, { ...common, turnover }, details, indexDriven));
          }
          const zAbs = Math.max(Math.abs(z5 ?? 0), Math.abs(zOpen ?? 0));
          const rv = rvol ?? burst;
          if (rv !== undefined && rv >= cfg.rvolThreshold && zAbs >= cfg.rvolMinZ) {
            out.push(this.fire(s, 'RVOL', ts, { ...common, turnover }, { ...details, rvolSource: rvol !== undefined ? 'cumulative_20d' : 'burst_5m' }, indexDriven));
          }
          if (rz !== undefined && Math.abs(rz) >= cfg.residualZThreshold) {
            out.push(this.fire(s, 'RESIDUAL', ts, { ...common, turnover }, details, false));
          }
        }

        // Change points on the standardized return.
        if (z1 !== undefined) {
          const c = s.cusum.update(Math.max(-6, Math.min(6, z1)));
          const pcp = s.bocpd.update(Math.max(-8, Math.min(8, z1)));
          if (c !== 0 || (pcp > 0.8 && s.bocpd.mapRunLength() < 5)) {
            out.push(this.fire(s, 'CHANGEPOINT', ts, { ...common, turnover }, { ...details, cusumDirection: c, bocpdRecentCpProb: pcp }, indexDriven && !isIndex));
          }
          this.volProfile.observe(mso, Math.abs(r) / Math.sqrt(s.normVar.var));
        }
        // Update the volatility model after detection, winsorized so a shock does not
        // blow up sigma for the next hour.
        const cap = s.normVar.n >= 30 ? 5 * Math.sqrt(s.normVar.var) : Infinity;
        const xr = r / prof;
        s.normVar.push(Math.max(-cap, Math.min(cap, xr)));
        s.resid.push(Math.max(-cap * prof, Math.min(cap * prof, residual)));
      }

      // Opening gap vs the index gap (first bar of the session).
      if (mso >= 0 && mso < 2 && s.gapChecked !== date && q_prevClose(this.quotes, b.key)) {
        s.gapChecked = date;
        const pc = q_prevClose(this.quotes, b.key)!;
        const gapPct = Math.log(b.open / pc);
        const dailySig = Math.sqrt(s.normVar.var) * Math.sqrt(375);
        if (!isIndex && dailySig > 0) {
          const bIdx = olsBeta(s.rets, s.idxRets) ?? 1;
          const gz = (gapPct - bIdx * this.lastIndexGapPct) / dailySig;
          if (Math.abs(gz) >= cfg.gapZThreshold) {
            out.push(this.fire(s, 'GAP', ts, { z: gz, price: b.open, ret: gapPct }, { gapPct, indexGapPct: this.lastIndexGapPct, dailySigma: dailySig }, false));
          }
        }
      }

      // Bands.
      const qb = this.quotes.get(b.key);
      if (qb?.band && !isIndex) {
        const atrV = this.quotes.atr(b.key) ?? 0;
        const d = bandDistance(b.close, qb.band, atrV, s.inst.tickSize);
        if (d.lockedUpper || d.lockedLower) {
          out.push(this.fire(s, 'BAND_HIT', ts, { price: b.close, bandHit: true }, { side: d.lockedUpper ? 'UPPER' : 'LOWER', band: qb.band }, false));
        } else if (Math.min(d.toUpper, d.toLower) / b.close < 0.01) {
          out.push(this.fire(s, 'BAND_PROXIMITY', ts, { price: b.close }, { toUpper: d.toUpper, toLower: d.toLower, band: qb.band }, false));
        }
      }

      // Open interest.
      if (b.oi !== undefined && b.oi > 0) {
        if (s.lastOi !== undefined && s.lastOi > 0) {
          const dOi = (b.oi - s.lastOi) / s.lastOi;
          const oz = s.dOi.z(dOi);
          s.dOi.push(dOi);
          if (oz !== undefined && Math.abs(oz) >= cfg.oiZThreshold) {
            const dP = s.lastClose ? b.close - s.lastClose : 0;
            out.push(this.fire(s, 'OI_SPIKE', ts, { z: oz, price: b.close }, { dOiPct: dOi, buildup: buildup(dP, dOi) }, false));
          }
        }
        s.lastOi = b.oi;
      }
      const iv = this.quotes.get(b.key)?.last?.iv;
      if (iv !== undefined && iv > 0) {
        if (s.lastIv !== undefined) {
          const d = iv - s.lastIv;
          const iz = s.dIv.z(d);
          s.dIv.push(d);
          if (iz !== undefined && Math.abs(iz) >= cfg.ivZThreshold) out.push(this.fire(s, 'IV_JUMP', ts, { z: iz, price: b.close }, { iv, dIv: d }, false));
        }
        s.lastIv = iv;
      }

      s.lastClose = b.close;
      s.closes.push(b.close);
      if (s.closes.length > 10) s.closes.shift();
      s.barVols.push(b.volume);
      if (s.barVols.length > HIST) s.barVols.shift();
    }
    this.stats.processedMinutes++;
    this.stats.lastRunMs = Math.round((performance.now() - t0) * 100) / 100;
    return out.filter((a) => a.id);
  }

  /** 1-second pass: live price vs last bar close for Tier A/B (faster than waiting for the bar). */
  scanTicks(now = this.now()): Anomaly[] {
    const cfg = this.cfg();
    const prof = this.volProfile.factor(minutesSinceOpen(now));
    const out: Anomaly[] = [];
    for (const s of this.states.values()) {
      if (s.tier !== 'A' && s.tier !== 'B') continue;
      if (!s.lastClose || s.normVar.n < 30) continue;
      const t: Tick | undefined = this.quotes.get(s.inst.key)?.last;
      if (!t || now - t.recvTs > 5000) continue;
      const z = Math.log(t.ltp / s.lastClose) / (Math.sqrt(s.normVar.var) * prof);
      if (Math.abs(z) >= cfg.zThreshold * 1.25) {
        const type: AnomalyType = s.inst.key === this.indexKey ? 'INDEX_SHOCK' : 'RETURN_SHOCK';
        const a = this.fire(s, type, now, { z, price: t.ltp, ret: Math.log(t.ltp / s.lastClose) }, { intraMinute: true, z1Live: z }, false);
        if (a.id) out.push(a);
      }
    }
    return out;
  }

  private fire(s: SymState, type: AnomalyType, ts: number, m: { z?: number; rvol?: number; residualZ?: number; price: number; ret?: number; turnover?: number; bandHit?: boolean }, details: Record<string, unknown>, suppressed: boolean): Anomaly {
    const cfg = this.cfg();
    const last = s.lastFired.get(type);
    if (last !== undefined && ts - last < cfg.debounceMin * 60_000) return { id: '' } as Anomaly;
    s.lastFired.set(type, ts);
    const sev = severity({ z: m.z, rvol: m.rvol, residualZ: m.residualZ, minuteTurnover: m.turnover, bandHit: m.bandHit });
    const a: Anomaly = {
      id: newId('A'), key: s.inst.key, symbol: s.inst.symbol, type, ts, severity: sev,
      z: finite(m.z), rvol: finite(m.rvol), residualZ: finite(m.residualZ), ret: finite(m.ret), price: m.price,
      tier: s.tier, details: clean(details), suppressed,
    };
    this.db.run(
      'INSERT INTO anomalies (id, key, symbol, type, ts, severity, price, tier, suppressed, researched, details) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      a.id, a.key, a.symbol, a.type, a.ts, a.severity, a.price, a.tier, suppressed ? 1 : 0, 0, JSON.stringify({ ...a.details, z: a.z, rvol: a.rvol, residualZ: a.residualZ, ret: a.ret }),
    );
    this.stats.anomalies++;
    if (suppressed) this.stats.suppressed++;
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    this.bus.publish('anomaly', a);
    return a;
  }

  /** Label anomalies with forward returns (5m, 30m, next day) once the horizon has passed. */
  labelForwardReturns(now = this.now()): number {
    let n = 0;
    const horizons: [string, number][] = [['fwd_ret_5m', 5 * 60_000], ['fwd_ret_30m', 30 * 60_000], ['fwd_ret_1d', 24 * 3600_000]];
    for (const [col, h] of horizons) {
      const rows = this.db.all<{ id: string; key: string; ts: number; price: number }>(
        `SELECT id, key, ts, price FROM anomalies WHERE ${col} IS NULL AND ts <= ? AND ts > ? LIMIT 500`, now - h, now - h - 3 * 24 * 3600_000,
      );
      for (const r of rows) {
        const bars = this.quotes.bars(r.key);
        const target = bars.find((b) => b.ts >= r.ts + h);
        if (!target || r.price <= 0) continue;
        this.db.run(`UPDATE anomalies SET ${col} = ? WHERE id = ?`, Math.log(target.close / r.price), r.id);
        n++;
      }
    }
    return n;
  }

  stateOf(key: string): { sigma1m?: number; tier?: string; historyDays?: number } {
    const s = this.states.get(key);
    return s ? { sigma1m: Math.sqrt(s.normVar.var), tier: s.tier, historyDays: s.vol.historyDays() } : {};
  }
}

function q_prevClose(q: QuoteBook, key: string): number | undefined {
  return q.get(key)?.prevClose;
}

function finite(x: number | undefined): number | undefined {
  return x !== undefined && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : undefined;
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null) : v;
  }
  return out;
}
