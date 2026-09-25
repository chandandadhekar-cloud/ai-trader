// Price-band (circuit) modelling (plan §P0.3).
//  - Non-F&O equities: static bands of 2/5/10/20% of the previous close (sec_list.csv).
//  - F&O stocks: no fixed circuit. NSE applies a 10% dynamic ("dummy") band that
//    flexes by 5% at a time after a 15-minute cooling-off period once enough trades
//    print near the band (>= 50 trades by >= 10 UCCs and >= 3 TMs on each side).
//    When it flexes, the opposite band slides too (the window moves), and resting
//    orders outside the new band are cancelled.
// We cannot observe UCC/TM counts, so the simulator flexes after the price has
// stayed within `touchPct` of the band for the cooling-off period with trades printing.

export function roundToTick(p: number, tick = 0.05, mode: 'down' | 'up' | 'nearest' = 'nearest'): number {
  const n = p / tick;
  const r = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
  return Math.round(r * tick * 100) / 100;
}

export interface Band {
  lower: number;
  upper: number;
  pct: number;
  dynamic: boolean;
}

export function staticBand(prevClose: number, pct: number, tick = 0.05): Band {
  return {
    lower: roundToTick(prevClose * (1 - pct / 100), tick, 'up'),
    upper: roundToTick(prevClose * (1 + pct / 100), tick, 'down'),
    pct,
    dynamic: false,
  };
}

export class DynamicBand {
  readonly prevClose: number;
  readonly tick: number;
  readonly touchPct: number;
  readonly coolOffMs: number;
  /** Signed offsets in percent from prev close. */
  private lowOff = -10;
  private highOff = 10;
  private touchingSince?: number;
  private touchingSide?: 'upper' | 'lower';
  flexes = 0;

  constructor(prevClose: number, tick = 0.05, touchPct = 0.25, coolOffMs = 15 * 60 * 1000) {
    this.prevClose = prevClose;
    this.tick = tick;
    this.touchPct = touchPct;
    this.coolOffMs = coolOffMs;
  }

  band(): Band {
    return {
      lower: roundToTick(this.prevClose * (1 + this.lowOff / 100), this.tick, 'up'),
      upper: roundToTick(this.prevClose * (1 + this.highOff / 100), this.tick, 'down'),
      pct: this.highOff,
      dynamic: true,
    };
  }

  /** Feed each trade print. Returns true if the band flexed on this print. */
  onTrade(ts: number, price: number): boolean {
    const b = this.band();
    const nearUpper = price >= b.upper * (1 - this.touchPct / 100);
    const nearLower = price <= b.lower * (1 + this.touchPct / 100);
    const side = nearUpper ? 'upper' : nearLower ? 'lower' : undefined;
    if (!side) {
      this.touchingSince = undefined;
      this.touchingSide = undefined;
      return false;
    }
    if (this.touchingSide !== side) {
      this.touchingSide = side;
      this.touchingSince = ts;
      return false;
    }
    if (ts - (this.touchingSince ?? ts) >= this.coolOffMs) {
      const d = side === 'upper' ? 5 : -5;
      this.highOff += d;
      this.lowOff += d;
      this.flexes++;
      this.touchingSince = undefined;
      this.touchingSide = undefined;
      return true;
    }
    return false;
  }
}

export interface BandDistance {
  /** Distance to the upper band in price units (>= 0 inside the band). */
  toUpper: number;
  toLower: number;
  /** Distance to the nearest band in ATRs. */
  nearestAtr: number;
  lockedUpper: boolean;
  lockedLower: boolean;
}

export function bandDistance(price: number, band: Band, atrValue: number, tick = 0.05): BandDistance {
  const toUpper = band.upper - price;
  const toLower = price - band.lower;
  const nearest = Math.min(toUpper, toLower);
  return {
    toUpper,
    toLower,
    nearestAtr: atrValue > 0 ? nearest / atrValue : Infinity,
    lockedUpper: toUpper <= tick / 2,
    lockedLower: toLower <= tick / 2,
  };
}
