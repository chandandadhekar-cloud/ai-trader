// Fill simulator shared by the paper broker and the backtester (plan §P1.11, §P0.3).
// Models: bid/ask spread, square-root market impact, participation-capped partial
// fills, conservative resting-limit fills (price must trade THROUGH the limit),
// stop triggering, price-band rejection and band-lock (no counterparty) behaviour.

import type { OrderType, Side } from '../core/types.ts';
import type { Band } from '../surveillance/bands.ts';
import { roundToTick } from '../surveillance/bands.ts';

export interface MarketSnapshot {
  ts: number;
  ltp: number;
  bid?: number;
  ask?: number;
  /** For bar-based simulation: the bar's range. */
  open?: number;
  high?: number;
  low?: number;
  /** Volume in the current/next minute. */
  volume1m: number;
  /** Std-dev of 1-minute log returns. */
  sigma1m: number;
  band?: Band;
  tick: number;
  /** False during auctions / closed sessions: continuous-book orders cannot match. */
  continuous: boolean;
}

export interface SimOrder {
  side: Side;
  qty: number; // remaining
  type: OrderType;
  limit?: number;
  trigger?: number;
  triggered?: boolean;
  lotSize: number;
}

export interface SimParams {
  /** Assumed spread in bps when no quote is available. */
  defaultSpreadBps: number;
  /** Square-root impact coefficient (impact = k * sigma1m * sqrt(q / vol1m)). */
  impactK: number;
  /** Max share of a minute's volume the simulator lets us take. */
  participationCap: number;
  /** Multiply all slippage (stress test: "survives doubled slippage"). */
  slippageMultiplier: number;
}

export const DEFAULT_SIM: SimParams = { defaultSpreadBps: 5, impactK: 1.0, participationCap: 0.1, slippageMultiplier: 1 };

export interface SimResult {
  fillQty: number;
  fillPrice: number;
  triggered: boolean;
  rejected?: string;
  slippageBps?: number;
}

function halfSpread(s: MarketSnapshot, p: SimParams): number {
  if (s.bid && s.ask && s.ask > s.bid) return (s.ask - s.bid) / 2;
  return (s.ltp * p.defaultSpreadBps) / 1e4 / 2;
}

export function impactPrice(side: Side, ref: number, qty: number, s: MarketSnapshot, p: SimParams): number {
  const hs = halfSpread(s, p);
  const vol = Math.max(s.volume1m, 1);
  const impact = ref * p.impactK * Math.max(s.sigma1m, 1e-5) * Math.sqrt(qty / vol);
  const slip = (hs + impact) * p.slippageMultiplier;
  return side === 'BUY' ? ref + slip : ref - slip;
}

export function simulateFill(o: SimOrder, s: MarketSnapshot, p: SimParams = DEFAULT_SIM): SimResult {
  const none = (rejected?: string): SimResult => ({ fillQty: 0, fillPrice: 0, triggered: !!o.triggered, rejected });
  if (o.qty <= 0) return none();
  if (!s.continuous) return none();

  const hi = s.high ?? s.ltp;
  const lo = s.low ?? s.ltp;

  // Band rules: limit prices outside the band are rejected by the exchange.
  if (s.band && o.limit !== undefined && (o.limit > s.band.upper + 1e-9 || o.limit < s.band.lower - 1e-9)) {
    return none(`limit ${o.limit} outside band [${s.band.lower}, ${s.band.upper}]`);
  }
  // Band lock: at the upper band there are only buyers (buys cannot fill), and vice versa.
  if (s.band) {
    const lockedUp = s.ltp >= s.band.upper - s.tick / 2 && lo >= s.band.upper - s.tick / 2;
    const lockedDn = s.ltp <= s.band.lower + s.tick / 2 && hi <= s.band.lower + s.tick / 2;
    if ((o.side === 'BUY' && lockedUp) || (o.side === 'SELL' && lockedDn)) return none();
  }

  // Stops: trigger on touch.
  let triggered = !!o.triggered;
  if ((o.type === 'SL' || o.type === 'SL-M') && !triggered) {
    if (o.trigger === undefined) return none('stop without trigger');
    triggered = o.side === 'SELL' ? lo <= o.trigger : hi >= o.trigger;
    if (!triggered) return none();
  }

  const maxQty = Math.floor((p.participationCap * Math.max(s.volume1m, 0)) / o.lotSize) * o.lotSize;
  const qty = Math.min(o.qty, maxQty > 0 ? maxQty : s.volume1m > 0 ? 0 : o.lotSize);
  if (qty <= 0) return { ...none(), triggered };

  if (o.type === 'LIMIT' || o.type === 'SL') {
    const lim = o.limit!;
    // Aggressive side of the book at order time.
    const touch = o.side === 'BUY' ? s.ask ?? s.ltp + halfSpread(s, p) : s.bid ?? s.ltp - halfSpread(s, p);
    const marketableNow = o.side === 'BUY' ? touch <= lim : touch >= lim;
    if (marketableNow) {
      // impactPrice adds half-spread + impact to the mid.
      let px = impactPrice(o.side, o.side === 'BUY' ? touch - halfSpread(s, p) : touch + halfSpread(s, p), qty, s, p);
      // A limit order never fills worse than its limit.
      px = o.side === 'BUY' ? Math.min(px, lim) : Math.max(px, lim);
      return finalize(o, qty, px, s, triggered);
    }
    // Resting: require trading through the limit by at least one tick (queue position).
    const through = o.side === 'BUY' ? lo <= lim - s.tick : hi >= lim + s.tick;
    if (!through) return { ...none(), triggered };
    const gapPx = s.open !== undefined && (o.side === 'BUY' ? s.open < lim : s.open > lim) ? s.open : lim;
    return finalize(o, qty, gapPx, s, triggered);
  }

  // MARKET / SL-M: fill at the touch plus impact; gap-through uses the bar open.
  const ref = s.open ?? s.ltp;
  let ref2 = ref;
  if ((o.type === 'SL-M') && o.trigger !== undefined) ref2 = o.side === 'SELL' ? Math.min(ref, o.trigger) : Math.max(ref, o.trigger);
  const px = impactPrice(o.side, ref2, qty, s, p);
  if (s.band) {
    const clamped = Math.min(Math.max(px, s.band.lower), s.band.upper);
    return finalize(o, qty, clamped, s, triggered);
  }
  return finalize(o, qty, px, s, triggered);
}

function finalize(o: SimOrder, qty: number, px: number, s: MarketSnapshot, triggered: boolean): SimResult {
  const rounded = roundToTick(px, s.tick, o.side === 'BUY' ? 'up' : 'down');
  const ref = s.ltp;
  const slippageBps = ref > 0 ? ((o.side === 'BUY' ? rounded - ref : ref - rounded) / ref) * 1e4 : 0;
  return { fillQty: qty, fillPrice: rounded, triggered, slippageBps };
}
