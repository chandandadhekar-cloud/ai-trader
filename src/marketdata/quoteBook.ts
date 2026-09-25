// Latest-state store per instrument: last tick, rolling 1-minute bars, EWMA
// volatility of 1-minute returns, session VWAP, typical trade size and band.
// Every consumer (risk, strategies, paper broker, scanner triage) reads from here,
// so backtest and live see identical derived values.

import type { Bar, Tick } from '../core/types.ts';
import { atr } from '../features/technical.ts';
import type { Band } from '../surveillance/bands.ts';
import { staticBand } from '../surveillance/bands.ts';
import { istDate } from '../core/clock.ts';
import type { MarketSnapshot } from '../sim/fillSimulator.ts';

export interface QuoteState {
  key: string;
  last?: Tick;
  bars: Bar[];
  prevClose?: number;
  sigma1m: number;
  vwapPv: number;
  vwapV: number;
  vwapDate?: string;
  medianTradeQty?: number;
  band?: Band;
  dayHigh?: number;
  dayLow?: number;
  dayOpen?: number;
}

const MAX_BARS = 1500; // ~4 sessions of 1-minute bars

export class QuoteBook {
  private states = new Map<string, QuoteState>();

  private st(key: string): QuoteState {
    let s = this.states.get(key);
    if (!s) this.states.set(key, (s = { key, bars: [], sigma1m: 0.002, vwapPv: 0, vwapV: 0 }));
    return s;
  }

  onTick(t: Tick): void {
    const s = this.st(t.key);
    const d = istDate(t.ltt || t.recvTs);
    if (s.vwapDate !== d) {
      if (s.last) s.prevClose = s.last.ltp;
      s.vwapDate = d;
      s.vwapPv = 0;
      s.vwapV = 0;
      s.dayHigh = s.dayLow = s.dayOpen = undefined;
    }
    if (t.cp) s.prevClose = t.cp;
    if (t.ltq && t.ltq > 0) {
      s.vwapPv += t.ltp * t.ltq;
      s.vwapV += t.ltq;
      s.medianTradeQty = s.medianTradeQty === undefined ? t.ltq : 0.98 * s.medianTradeQty + 0.02 * t.ltq;
    }
    s.dayHigh = Math.max(s.dayHigh ?? t.ltp, t.ltp);
    s.dayLow = Math.min(s.dayLow ?? t.ltp, t.ltp);
    s.dayOpen ??= t.ltp;
    s.last = t;
  }

  onBar(b: Bar): void {
    const s = this.st(b.key);
    const prev = s.bars[s.bars.length - 1];
    if (prev && b.ts <= prev.ts) return;
    if (prev && prev.close > 0 && b.close > 0) {
      const r = Math.log(b.close / prev.close);
      // EWMA variance (RiskMetrics-style lambda 0.97 on 1-minute returns).
      s.sigma1m = Math.sqrt(0.97 * s.sigma1m ** 2 + 0.03 * r * r);
    }
    s.bars.push(b);
    if (s.bars.length > MAX_BARS) s.bars.splice(0, s.bars.length - MAX_BARS);
    if (!s.last) s.last = { key: b.key, ltp: b.close, ltt: b.ts + 59_999, recvTs: b.ts + 59_999, source: 'backtest' };
  }

  setBand(key: string, band: Band): void {
    this.st(key).band = band;
  }

  setStaticBandPct(key: string, pct: number, tick: number): void {
    const s = this.st(key);
    if (s.prevClose) s.band = staticBand(s.prevClose, pct, tick);
  }

  setPrevClose(key: string, pc: number): void {
    this.st(key).prevClose = pc;
  }

  get(key: string): QuoteState | undefined {
    return this.states.get(key);
  }

  ltp(key: string): number | undefined {
    return this.states.get(key)?.last?.ltp;
  }

  bars(key: string, n?: number): Bar[] {
    const b = this.states.get(key)?.bars ?? [];
    return n ? b.slice(-n) : b;
  }

  atr(key: string, n = 14): number | undefined {
    return atr(this.bars(key, n * 4), n);
  }

  vwap(key: string): number | undefined {
    const s = this.states.get(key);
    return s && s.vwapV > 0 ? s.vwapPv / s.vwapV : undefined;
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  /** Snapshot for the fill simulator. */
  snapshot(key: string, tick: number, continuous: boolean): MarketSnapshot | undefined {
    const s = this.states.get(key);
    if (!s?.last) return undefined;
    const lastBar = s.bars[s.bars.length - 1];
    // Typical minute volume: median of recent bars (robust to a single spike).
    const vols = s.bars.slice(-30).map((b) => b.volume).sort((a, b) => a - b);
    const vol1m = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
    return {
      ts: s.last.recvTs,
      ltp: s.last.ltp,
      bid: s.last.bid,
      ask: s.last.ask,
      volume1m: vol1m || lastBar?.volume || 0,
      sigma1m: s.sigma1m,
      band: s.band,
      tick,
      continuous,
    };
  }
}
