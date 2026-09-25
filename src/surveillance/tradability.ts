// Tradability gate: runs before every entry (plan §P0.2/§P0.3).
// Hard rules — never initiate on:
//  - trade-to-trade / BE-series (and other non-rolling series), SME series
//  - any GSM stage, tighter ASM stages (LT-ASM >= 2, ST-ASM >= 2), ESM, IBC
//  - fresh F&O positions in ban-period underlyings (reducing trades only)
//  - price locked at a band, or within `bandBufferAtr` x ATR of a band
// Softer flags (LT-ASM 1, ST-ASM 1, narrow 2%/5% bands) halve size.

import type { Instrument } from '../core/types.ts';
import type { SurveillanceFlags } from './nseFiles.ts';
import { bandDistance, type Band } from './bands.ts';

export const T2T_SERIES = new Set(['BE', 'BZ', 'BT', 'IL', 'RL']);
export const SME_SERIES = new Set(['SM', 'ST', 'SZ']);

export interface GateInput {
  instrument: Instrument;
  flags?: SurveillanceFlags;
  /** Underlying's surveillance flags for derivatives. */
  underlyingFlags?: SurveillanceFlags;
  price: number;
  atr?: number;
  band?: Band;
  reduceOnly?: boolean;
  bandBufferAtr: number;
  /** Blocks from research (BLOCK verdict) for the day. */
  researchBlocked?: boolean;
  /** Data staleness from marketdata/staleness.ts. */
  stale?: boolean;
}

export interface GateResult {
  allowed: boolean;
  /** Multiply position size by this (0..1). */
  sizeMultiplier: number;
  reasons: string[];
  flags: string[];
}

export function tradabilityGate(g: GateInput): GateResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  let size = 1;
  const f = g.flags;
  const isDeriv = g.instrument.type === 'FUT' || g.instrument.type === 'CE' || g.instrument.type === 'PE';
  const uf = isDeriv ? g.underlyingFlags : f;
  const isCrypto = g.instrument.venue === 'DELTA';

  if (g.stale) {
    if (g.reduceOnly) flags.push('STALE_DATA');
    else reasons.push('STALE_DATA: entries blocked on stale quotes');
  }
  if (g.researchBlocked && !g.reduceOnly) reasons.push('RESEARCH_BLOCK: symbol blocked for today');

  if (!isCrypto && !g.reduceOnly) {
    const series = f?.series ?? g.instrument.series;
    if (series && T2T_SERIES.has(series)) reasons.push(`T2T_SERIES: ${series}`);
    if (series && SME_SERIES.has(series)) reasons.push(`SME_SERIES: ${series}`);
    if (uf) {
      if (uf.gsm > 0) reasons.push(`GSM_STAGE_${uf.gsm}`);
      if (uf.ltAsm >= 2) reasons.push(`LT_ASM_STAGE_${uf.ltAsm}`);
      else if (uf.ltAsm === 1) { flags.push('LT_ASM_STAGE_1'); size *= 0.5; }
      if (uf.stAsm >= 2) reasons.push(`ST_ASM_STAGE_${uf.stAsm}`);
      else if (uf.stAsm === 1) { flags.push('ST_ASM_STAGE_1'); size *= 0.5; }
      if (uf.esm > 0) reasons.push(`ESM_STAGE_${uf.esm}`);
      if (uf.ibc) reasons.push('IBC');
      if (isDeriv && uf.inFnoBan) reasons.push('FNO_BAN: only reducing trades allowed');
    }
    if (f?.bandPct !== undefined && f.bandPct <= 5) { flags.push(`NARROW_BAND_${f.bandPct}`); size *= 0.5; }
  }

  if (g.band && !isCrypto) {
    const d = bandDistance(g.price, g.band, g.atr ?? 0, g.instrument.tickSize);
    if (d.lockedUpper || d.lockedLower) {
      // A locked band means exits may be impossible. Block entries; flag for exits.
      if (g.reduceOnly) flags.push('BAND_LOCKED_EXIT_RISK');
      else reasons.push(`BAND_LOCKED_${d.lockedUpper ? 'UPPER' : 'LOWER'}: exit-impossible risk`);
    } else if (!g.reduceOnly && g.atr && d.nearestAtr < g.bandBufferAtr) {
      reasons.push(`NEAR_BAND: ${d.nearestAtr.toFixed(2)} ATR from band (< ${g.bandBufferAtr})`);
    }
  }

  return { allowed: reasons.length === 0, sizeMultiplier: reasons.length ? 0 : size, reasons, flags };
}
