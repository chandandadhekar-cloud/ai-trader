// Synthetic market for demo / development when no broker credentials are set.
// Clearly flagged as SYNTHETIC everywhere it surfaces. It exercises the whole
// pipeline: index factor + sector factor + idiosyncratic noise, a U-shaped
// intraday volatility profile, occasional idiosyncratic jumps with volume
// surges (some preceded by a synthetic "filing"), and rare index-wide shocks.

import type { Instrument, Tick } from '../core/types.ts';
import { istParts } from '../core/clock.ts';

export interface SyntheticFiling {
  id: string;
  symbol: string;
  ts: number;
  title: string;
  category: string;
  source: 'exchange_filing' | 'news' | 'social';
  direction: 1 | -1;
}

interface SymState {
  inst: Instrument;
  price: number;
  prevClose: number;
  beta: number;
  sector: string;
  vtt: number;
  baseVolPerSec: number;
  surgeUntil: number;
  drift: number;
  driftUntil: number;
}

const UNIVERSE: [string, string, number, number][] = [
  // symbol, sector, price, beta
  ['RELIANCE', 'ENERGY', 1420, 1.0], ['ONGC', 'ENERGY', 245, 0.9], ['BPCL', 'ENERGY', 320, 1.1], ['NTPC', 'POWER', 340, 0.8],
  ['POWERGRID', 'POWER', 295, 0.7], ['TATAPOWER', 'POWER', 390, 1.3], ['HDFCBANK', 'BANK', 1650, 0.9], ['ICICIBANK', 'BANK', 1320, 1.0],
  ['SBIN', 'BANK', 810, 1.2], ['AXISBANK', 'BANK', 1150, 1.1], ['KOTAKBANK', 'BANK', 2050, 0.8], ['INDUSINDBK', 'BANK', 780, 1.4],
  ['BAJFINANCE', 'FIN', 890, 1.3], ['SHRIRAMFIN', 'FIN', 640, 1.4], ['INFY', 'IT', 1510, 0.8], ['TCS', 'IT', 3120, 0.7],
  ['WIPRO', 'IT', 255, 0.8], ['HCLTECH', 'IT', 1480, 0.8], ['TECHM', 'IT', 1460, 0.9], ['LTIM', 'IT', 5200, 0.9],
  ['MARUTI', 'AUTO', 12800, 0.8], ['TATAMOTORS', 'AUTO', 690, 1.4], ['M&M', 'AUTO', 3150, 1.1], ['EICHERMOT', 'AUTO', 5900, 0.9],
  ['SUNPHARMA', 'PHARMA', 1650, 0.6], ['CIPLA', 'PHARMA', 1520, 0.6], ['DRREDDY', 'PHARMA', 1270, 0.6], ['DIVISLAB', 'PHARMA', 6100, 0.7],
  ['ITC', 'FMCG', 410, 0.5], ['HINDUNILVR', 'FMCG', 2480, 0.5], ['NESTLEIND', 'FMCG', 1180, 0.5], ['TITAN', 'CONSUMER', 3450, 0.9],
  ['LT', 'INFRA', 3600, 1.0], ['ADANIPORTS', 'INFRA', 1390, 1.4], ['ULTRACEMCO', 'CEMENT', 12100, 0.8], ['GRASIM', 'CEMENT', 2750, 0.9],
  ['TATASTEEL', 'METAL', 165, 1.5], ['JSWSTEEL', 'METAL', 1060, 1.3], ['HINDALCO', 'METAL', 740, 1.4], ['BHARTIARTL', 'TELECOM', 1890, 0.7],
];

export const SYNTH_INDEX_KEY = 'NSE_INDEX|Nifty 50';

export function syntheticInstruments(): Instrument[] {
  const out: Instrument[] = [
    { key: SYNTH_INDEX_KEY, symbol: 'NIFTY 50', venue: 'NSE', segment: 'NSE_INDEX', type: 'INDEX', lotSize: 1, tickSize: 0.05 },
  ];
  for (const [sym, sector] of UNIVERSE) {
    out.push({ key: `NSE_EQ|SYN:${sym}`, symbol: sym, venue: 'NSE', segment: 'NSE_EQ', type: 'EQ', lotSize: 1, tickSize: sym === 'TATASTEEL' || sym === 'ONGC' ? 0.01 : 0.05, sector, series: 'EQ', isFnO: true, casEligible: true });
  }
  return out;
}

/** Mulberry32 seeded PRNG so demos are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SyntheticMarket {
  private syms: SymState[] = [];
  private index = { price: 25100, prevClose: 25100 };
  private sectorShock = new Map<string, number>();
  private rand: () => number;
  private timer?: NodeJS.Timeout;
  readonly filings: SyntheticFiling[] = [];
  private onTick: (t: Tick) => void;
  private onFiling?: (f: SyntheticFiling) => void;
  readonly stepMs: number;
  private filingSeq = 0;

  constructor(onTick: (t: Tick) => void, opts: { seed?: number; stepMs?: number; onFiling?: (f: SyntheticFiling) => void } = {}) {
    this.onTick = onTick;
    this.onFiling = opts.onFiling;
    this.stepMs = opts.stepMs ?? 1000;
    this.rand = rng(opts.seed ?? 42);
    const insts = syntheticInstruments().filter((i) => i.type === 'EQ');
    for (const inst of insts) {
      const u = UNIVERSE.find((x) => x[0] === inst.symbol)!;
      this.syms.push({
        inst, price: u[2], prevClose: u[2], beta: u[3], sector: u[1], vtt: 0,
        // ~₹300 cr/day turnover per name → realistic minute volumes for sizing caps.
        baseVolPerSec: Math.max(5, Math.round(3e9 / u[2] / 22500)), surgeUntil: 0, drift: 0, driftUntil: 0,
      });
    }
  }

  private gauss(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rand();
    while (v === 0) v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** U-shaped intraday volatility multiplier (higher at open and close). */
  private uShape(ts: number): number {
    const m = istParts(ts).minuteOfDay - 555; // minutes since 09:15
    const x = Math.min(Math.max(m, 0), 375) / 375;
    return 0.7 + 1.6 * (x - 0.5) ** 2 * 4 * 0.5;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(Date.now()), this.stepMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  prevCloses(): Map<string, number> {
    const m = new Map<string, number>([[SYNTH_INDEX_KEY, this.index.prevClose]]);
    for (const s of this.syms) m.set(s.inst.key, s.prevClose);
    return m;
  }

  step(now: number, stepMs = this.stepMs): void {
    const dt = stepMs / 1000;
    const secVol = 0.16 / Math.sqrt(252 * 22500); // ~16% annualised index vol per second
    const u = this.uShape(now);
    let idxRet = secVol * u * this.gauss() * Math.sqrt(dt);
    // Rare index-wide shock (~ once per 2 hours at 1s steps).
    if (this.rand() < dt / 7200) idxRet += (this.rand() < 0.5 ? -1 : 1) * 0.006;
    this.index.price *= Math.exp(idxRet);
    this.onTick({ key: SYNTH_INDEX_KEY, ltp: round(this.index.price, 0.05), ltt: now, recvTs: now, cp: this.index.prevClose, source: 'synthetic' });

    for (const [sec, v] of this.sectorShock) this.sectorShock.set(sec, v * 0.9);
    for (const s of this.syms) {
      const idio = secVol * 1.8 * u * this.gauss() * Math.sqrt(dt);
      let r = s.beta * idxRet + (this.sectorShock.get(s.sector) ?? 0) * dt + idio;
      if (now < s.driftUntil) r += s.drift * dt;
      // Idiosyncratic event: ~ one per stock every ~6 hours.
      if (this.rand() < dt / 21600) {
        const dir: 1 | -1 = this.rand() < 0.5 ? -1 : 1;
        const size = 0.01 + this.rand() * 0.025;
        r += dir * size;
        s.surgeUntil = now + 5 * 60_000;
        const hasFiling = this.rand() < 0.6;
        if (hasFiling) {
          // Filing precedes the move; drift continues for a while (post-news drift).
          s.drift = (dir * size * 0.4) / 1800;
          s.driftUntil = now + 30 * 60_000;
          const cats = dir > 0 ? ['Order win', 'Results beat', 'Buyback announced', 'Capacity expansion'] : ['Results miss', 'Regulatory penalty', 'Promoter pledge', 'Plant shutdown'];
          const f: SyntheticFiling = {
            id: `SYN-F${++this.filingSeq}`, symbol: s.inst.symbol, ts: now - 20_000,
            title: `${s.inst.symbol}: ${cats[Math.floor(this.rand() * cats.length)]} (synthetic)`,
            category: 'corporate_announcement', source: 'exchange_filing', direction: dir,
          };
          this.filings.push(f);
          if (this.filings.length > 500) this.filings.shift();
          this.onFiling?.(f);
        }
      }
      s.price = Math.max(1, s.price * Math.exp(r));
      const surge = now < s.surgeUntil ? 6 : 1;
      const qty = Math.max(1, Math.round(s.baseVolPerSec * dt * surge * (0.5 + this.rand())));
      s.vtt += qty;
      const tick = s.inst.tickSize;
      const px = round(s.price, tick);
      const spread = Math.max(tick, round(px * 0.0003, tick));
      this.onTick({
        key: s.inst.key, ltp: px, ltt: now, recvTs: now, ltq: qty, cp: s.prevClose, vtt: s.vtt,
        bid: round(px - spread / 2, tick), ask: round(px + spread / 2, tick),
        tbq: Math.round(qty * 50 * (0.7 + this.rand() * 0.6)), tsq: Math.round(qty * 50 * (0.7 + this.rand() * 0.6)),
        source: 'synthetic',
      });
    }
  }
}

function round(p: number, tick: number): number {
  return Math.round(Math.round(p / tick) * tick * 100) / 100;
}
