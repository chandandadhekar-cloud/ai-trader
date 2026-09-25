// Primary strategies. Win-rate expectations (plan §G): trend/breakout systems
// often win 35–45% at R:R >= 2; mean reversion wins 55–65% with smaller winners.
// Parameters are deliberately few; every change is a new trial in the registry.

import type { Strategy, StrategyContext } from './base.ts';
import { emaSeries } from './base.ts';
import { rsi } from '../features/technical.ts';
import { minutesSinceOpen } from '../config/calendar.ts';

type Out = ReturnType<Strategy['evaluate']>;

export class TrendFollowing implements Strategy {
  readonly id = 'trend_following';
  readonly name = 'Intraday trend following';
  readonly description = 'EMA(20/50) alignment in a trending regime (efficiency ratio high); enter on a pullback to the fast EMA. Stop 1.5 ATR, target 3 ATR, 120-minute time stop.';
  readonly venues = ['NSE', 'BSE', 'DELTA'] as Strategy['venues'];
  readonly params: Record<string, number>;

  constructor(overrides: Record<string, number> = {}) {
    this.params = { fast: 20, slow: 50, stopAtr: 1.5, targetAtr: 3, timeStopMin: 120, ...overrides };
  }

  evaluate(c: StrategyContext): Out {
    if (c.regime !== 'trend' || !c.atr || c.bars.length < this.params.slow + 5) return;
    const closes = c.bars.map((b) => b.close);
    const f = emaSeries(closes, this.params.fast);
    const s = emaSeries(closes, this.params.slow);
    const n = closes.length - 1;
    const up = f[n] > s[n] && f[n - 5] > s[n - 5] && s[n] > s[n - 10];
    const dn = f[n] < s[n] && f[n - 5] < s[n - 5] && s[n] < s[n - 10];
    const last = c.bars[n];
    const touched = Math.abs(last.low - f[n]) < 0.3 * c.atr || Math.abs(last.high - f[n]) < 0.3 * c.atr;
    if (up && touched && last.close > f[n] && last.close > last.open) {
      return { instrumentKey: c.inst.key, side: 'BUY', strength: 0.6, entry: c.ltp, stop: c.ltp - this.params.stopAtr * c.atr, target: c.ltp + this.params.targetAtr * c.atr, timeStopMin: this.params.timeStopMin, reason: 'uptrend pullback to EMA20 held' };
    }
    if (dn && touched && last.close < f[n] && last.close < last.open) {
      return { instrumentKey: c.inst.key, side: 'SELL', strength: 0.6, entry: c.ltp, stop: c.ltp + this.params.stopAtr * c.atr, target: c.ltp - this.params.targetAtr * c.atr, timeStopMin: this.params.timeStopMin, reason: 'downtrend pullback to EMA20 rejected' };
    }
  }
}

export class MeanReversion implements Strategy {
  readonly id = 'mean_reversion';
  readonly name = 'VWAP mean reversion';
  readonly description = 'In a range regime, fade stretches > 2.5 ATR from session VWAP with RSI extreme and a reversal bar. Target VWAP, stop 1.2 ATR beyond entry, 45-minute time stop. Skips names with an active REACT verdict.';
  readonly venues = ['NSE', 'BSE', 'DELTA'] as Strategy['venues'];
  readonly params: Record<string, number>;

  constructor(overrides: Record<string, number> = {}) {
    this.params = { stretchAtr: 2.5, rsiHi: 75, rsiLo: 25, stopAtr: 1.2, timeStopMin: 45, ...overrides };
  }

  evaluate(c: StrategyContext): Out {
    if (c.regime !== 'range' || !c.atr || !c.vwap || c.todayBars.length < 30) return;
    if (c.verdict?.final === 'REACT') return; // do not fade real news
    const r = rsi(c.bars.slice(-60).map((b) => b.close), 14);
    if (r === undefined) return;
    const dist = (c.ltp - c.vwap) / c.atr;
    const last = c.bars[c.bars.length - 1];
    if (dist > this.params.stretchAtr && r > this.params.rsiHi && last.close < last.open) {
      return { instrumentKey: c.inst.key, side: 'SELL', strength: Math.min(1, dist / 4), entry: c.ltp, stop: c.ltp + this.params.stopAtr * c.atr, target: c.vwap, timeStopMin: this.params.timeStopMin, reason: `stretched ${dist.toFixed(1)} ATR above VWAP, RSI ${r.toFixed(0)}` };
    }
    if (dist < -this.params.stretchAtr && r < this.params.rsiLo && last.close > last.open) {
      return { instrumentKey: c.inst.key, side: 'BUY', strength: Math.min(1, -dist / 4), entry: c.ltp, stop: c.ltp - this.params.stopAtr * c.atr, target: c.vwap, timeStopMin: this.params.timeStopMin, reason: `stretched ${(-dist).toFixed(1)} ATR below VWAP, RSI ${r.toFixed(0)}` };
    }
  }
}

export class OpeningRangeBreakout implements Strategy {
  readonly id = 'breakout';
  readonly name = 'Opening-range breakout';
  readonly description = 'Break of the first-15-minute range between 09:30 and 11:30 with volume > 1.5x median; stop at the range midpoint, target 2R, 150-minute time stop.';
  readonly venues = ['NSE', 'BSE'] as Strategy['venues'];
  readonly params: Record<string, number>;

  constructor(overrides: Record<string, number> = {}) {
    this.params = { orMinutes: 15, volMult: 1.5, rr: 2, timeStopMin: 150, lastEntryMin: 135, ...overrides };
  }

  evaluate(c: StrategyContext): Out {
    const mso = minutesSinceOpen(c.now);
    if (mso < this.params.orMinutes || mso > this.params.lastEntryMin) return;
    const or = c.todayBars.filter((b) => minutesSinceOpen(b.ts) < this.params.orMinutes);
    if (or.length < this.params.orMinutes - 2) return;
    const hi = Math.max(...or.map((b) => b.high));
    const lo = Math.min(...or.map((b) => b.low));
    const mid = (hi + lo) / 2;
    const last = c.bars[c.bars.length - 1];
    const prev = c.bars[c.bars.length - 2];
    const vols = c.bars.slice(-60).map((b) => b.volume).sort((a, b) => a - b);
    const med = vols[Math.floor(vols.length / 2)] || 0;
    if (!prev || med <= 0 || last.volume < this.params.volMult * med) return;
    if (last.close > hi && prev.close <= hi) {
      const risk = c.ltp - mid;
      if (risk <= 0) return;
      return { instrumentKey: c.inst.key, side: 'BUY', strength: 0.55, entry: c.ltp, stop: mid, target: c.ltp + this.params.rr * risk, timeStopMin: this.params.timeStopMin, reason: `ORB up: close ${last.close} > OR high ${hi}` };
    }
    if (last.close < lo && prev.close >= lo) {
      const risk = mid - c.ltp;
      if (risk <= 0) return;
      return { instrumentKey: c.inst.key, side: 'SELL', strength: 0.55, entry: c.ltp, stop: mid, target: c.ltp - this.params.rr * risk, timeStopMin: this.params.timeStopMin, reason: `ORB down: close ${last.close} < OR low ${lo}` };
    }
  }
}

export class EventDriven implements Strategy {
  readonly id = 'event_driven';
  readonly name = 'Event drift (REACT verdicts)';
  readonly description = 'Trades the post-news drift, never the first tick: requires a fresh REACT verdict, then enters on a pullback toward VWAP that is reclaimed in the verdict direction. Reduced size, stop 1 ATR beyond VWAP, target 3 ATR, 240-minute time stop.';
  readonly venues = ['NSE', 'BSE', 'DELTA'] as Strategy['venues'];
  readonly params: Record<string, number>;

  constructor(overrides: Record<string, number> = {}) {
    this.params = { stopAtrBeyondVwap: 1, targetAtr: 3, timeStopMin: 240, pullbackAtr: 0.5, ...overrides };
  }

  evaluate(c: StrategyContext): Out {
    const v = c.verdict;
    if (!v || v.final !== 'REACT' || !c.atr || !c.vwap || c.bars.length < 6) return;
    const recent = c.bars.slice(-6);
    const last = recent[recent.length - 1];
    if (v.direction === 'UP') {
      const pulled = recent.slice(0, -1).some((b) => b.low - c.vwap! < this.params.pullbackAtr * c.atr!);
      if (pulled && last.close > c.vwap && last.close > recent[recent.length - 2].high) {
        return { instrumentKey: c.inst.key, side: 'BUY', strength: 0.5, entry: c.ltp, stop: c.vwap - this.params.stopAtrBeyondVwap * c.atr, target: c.ltp + this.params.targetAtr * c.atr, timeStopMin: this.params.timeStopMin, reason: `REACT UP (${v.causeCategory}): VWAP reclaim after pullback`, verdictId: v.id };
      }
    } else if (v.direction === 'DOWN') {
      const pulled = recent.slice(0, -1).some((b) => c.vwap! - b.high < this.params.pullbackAtr * c.atr!);
      if (pulled && last.close < c.vwap && last.close < recent[recent.length - 2].low) {
        return { instrumentKey: c.inst.key, side: 'SELL', strength: 0.5, entry: c.ltp, stop: c.vwap + this.params.stopAtrBeyondVwap * c.atr, target: c.ltp - this.params.targetAtr * c.atr, timeStopMin: this.params.timeStopMin, reason: `REACT DOWN (${v.causeCategory}): VWAP rejection after bounce`, verdictId: v.id };
      }
    }
  }
}

export class AnomalyFade implements Strategy {
  readonly id = 'anomaly_fade';
  readonly name = 'Anomaly fade (FADE verdicts)';
  readonly description = 'Fades moves with no identifiable cause (FADE verdict): enters against the shock once a bar closes back inside, targets 50% retracement, stop 0.5 ATR beyond the extreme, 20-minute time stop.';
  readonly venues = ['NSE', 'BSE', 'DELTA'] as Strategy['venues'];
  readonly params: Record<string, number>;

  constructor(overrides: Record<string, number> = {}) {
    this.params = { retrace: 0.5, stopAtr: 0.5, timeStopMin: 20, ...overrides };
  }

  evaluate(c: StrategyContext): Out {
    const v = c.verdict;
    if (!v || v.final !== 'FADE' || !c.atr) return;
    const a = c.recentAnomalies.find((x) => x.id === v.anomalyId) ?? c.recentAnomalies[0];
    if (!a || a.ret === undefined) return;
    const since = c.bars.filter((b) => b.ts >= a.ts - 5 * 60_000);
    if (since.length < 2) return;
    const last = since[since.length - 1];
    const start = a.price / Math.exp(a.ret);
    if (a.ret > 0) {
      const extreme = Math.max(...since.map((b) => b.high));
      if (last.close < last.open && c.ltp < extreme - 0.25 * c.atr) {
        return { instrumentKey: c.inst.key, side: 'SELL', strength: 0.5, entry: c.ltp, stop: extreme + this.params.stopAtr * c.atr, target: extreme - this.params.retrace * (extreme - start), timeStopMin: this.params.timeStopMin, reason: `fade unexplained +${(a.ret * 100).toFixed(2)}% shock`, verdictId: v.id };
      }
    } else {
      const extreme = Math.min(...since.map((b) => b.low));
      if (last.close > last.open && c.ltp > extreme + 0.25 * c.atr) {
        return { instrumentKey: c.inst.key, side: 'BUY', strength: 0.5, entry: c.ltp, stop: extreme - this.params.stopAtr * c.atr, target: extreme + this.params.retrace * (start - extreme), timeStopMin: this.params.timeStopMin, reason: `fade unexplained ${(a.ret * 100).toFixed(2)}% shock`, verdictId: v.id };
      }
    }
  }
}

export function defaultStrategies(): Strategy[] {
  return [new TrendFollowing(), new MeanReversion(), new OpeningRangeBreakout(), new EventDriven(), new AnomalyFade()];
}
