// Risk engine: the only component that sizes positions (the LLM never sizes).
// Pre-trade checks, in order; every rejection carries its reason:
//   kill switch → daily loss / drawdown halts → strategy circuit breaker →
//   tradability gate (surveillance, bands, staleness, research BLOCK) →
//   duplicate instrument → max positions → sector concentration → correlation →
//   sizing (0.5% risk per trade x gate x meta-label bet size) → lot rounding →
//   participation cap (<= 1% of 1-minute volume) → notional cap → gross exposure →
//   open-risk budget → cost/tax-aware minimum edge.

import type { Instrument, Signal } from '../core/types.ts';
import { TradingConfigSchema, type RiskLimits, type TradingConfig } from '../config/runtime.ts';
import type { Portfolio } from '../oms/portfolio.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { KillSwitch } from './killSwitch.ts';
import type { GateResult } from '../surveillance/tradability.ts';
import { feeFor } from '../oms/portfolio.ts';
import { correlation, logReturns } from '../features/technical.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';

export interface SizingDecision {
  approved: boolean;
  qty: number;
  reasons: string[];
  notional: number;
  riskAmount: number;
  checks: Record<string, number | string | boolean | undefined>;
}

export class RiskEngine {
  private portfolio: Portfolio;
  private quotes: QuoteBook;
  private kill: KillSwitch;
  private refdata: InstrumentRegistry;
  private limits: () => RiskLimits;
  private trading: () => TradingConfig;
  private strategyLosses = new Map<string, { date: string; consecutive: number; paused: boolean }>();

  constructor(opts: { portfolio: Portfolio; quotes: QuoteBook; kill: KillSwitch; refdata: InstrumentRegistry; limits: () => RiskLimits; trading?: () => TradingConfig }) {
    this.trading = opts.trading ?? (() => TradingConfigSchema.parse({}));
    this.portfolio = opts.portfolio;
    this.quotes = opts.quotes;
    this.kill = opts.kill;
    this.refdata = opts.refdata;
    this.limits = opts.limits;
  }

  /** Account-level breaches. Engages the kill switch when limits are hit. */
  checkAccount(now: number): { drawdown: number; dayPnlPct: number; halted: boolean } {
    const L = this.limits();
    const r = this.portfolio.refresh(now);
    if (r.drawdown >= L.maxDrawdownHalt) this.kill.engage(`drawdown ${(r.drawdown * 100).toFixed(2)}% >= ${(L.maxDrawdownHalt * 100).toFixed(1)}% halt`, 'risk-engine');
    const dayHalt = r.dayPnlPct <= -L.dailyLossLimit;
    return { drawdown: r.drawdown, dayPnlPct: r.dayPnlPct, halted: this.kill.engaged() || dayHalt };
  }

  recordTradeResult(strategyId: string, netPnl: number, date: string): void {
    const L = this.limits();
    let s = this.strategyLosses.get(strategyId);
    if (!s || s.date !== date) s = { date, consecutive: 0, paused: false };
    s.consecutive = netPnl < 0 ? s.consecutive + 1 : 0;
    if (s.consecutive >= L.maxConsecutiveLosses) s.paused = true;
    this.strategyLosses.set(strategyId, s);
  }

  strategyPaused(strategyId: string, date: string): boolean {
    const s = this.strategyLosses.get(strategyId);
    return !!s && s.date === date && s.paused;
  }

  strategyBreakers(): Record<string, { date: string; consecutive: number; paused: boolean }> {
    return Object.fromEntries(this.strategyLosses);
  }

  /** Leverage an instrument trades at under the current trade settings (1 = cash). */
  leverageFor(inst: Instrument): number {
    const T = this.trading();
    if (!T.leverageEnabled) return 1;
    if (inst.venue === 'DELTA') return T.cryptoLeverage;
    if (inst.type === 'EQ') return T.equityIntradayLeverage;
    return 1; // F&O: exchange SPAN margin already applies; no extra leverage
  }

  size(sig: Signal, inst: Instrument, gate: GateResult, metaSize: number, now: number, date: string, leverage = 1): SizingDecision {
    const L = this.limits();
    const reasons: string[] = [];
    const checks: SizingDecision['checks'] = {};
    const reject = (r: string): SizingDecision => ({ approved: false, qty: 0, reasons: [...reasons, r], notional: 0, riskAmount: 0, checks });

    if (this.kill.engaged()) return reject(`kill switch engaged: ${this.kill.get().reason}`);
    const acct = this.checkAccount(now);
    checks.drawdown = acct.drawdown;
    checks.dayPnlPct = acct.dayPnlPct;
    if (acct.dayPnlPct <= -L.dailyLossLimit) return reject(`daily loss ${(acct.dayPnlPct * 100).toFixed(2)}% beyond limit`);
    if (this.strategyPaused(sig.strategyId, date)) return reject(`${sig.strategyId} paused after ${L.maxConsecutiveLosses} consecutive losses`);
    if (!gate.allowed) return reject(`tradability: ${gate.reasons.join(', ')}`);

    if (this.portfolio.byInstrument(sig.instrumentKey).length) return reject('already positioned in this instrument');
    const open = this.portfolio.open();
    if (open.length >= L.maxOpenPositions) return reject(`max open positions (${L.maxOpenPositions})`);

    if (inst.sector) {
      const sameSector = open.filter((p) => this.refdata.byKey(p.instrumentKey)?.sector === inst.sector).length;
      checks.sameSector = sameSector;
      if (sameSector >= L.maxPerSector) return reject(`sector ${inst.sector} already has ${sameSector} positions`);
    }

    const myRets = logReturns(this.quotes.bars(sig.instrumentKey, 121).map((b) => b.close));
    for (const p of open) {
      const same = (p.qty > 0 && sig.side === 'BUY') || (p.qty < 0 && sig.side === 'SELL');
      if (!same) continue;
      const c = correlation(myRets, logReturns(this.quotes.bars(p.instrumentKey, 121).map((b) => b.close)));
      if (c !== undefined && c > L.correlationThreshold) return reject(`correlated (${c.toFixed(2)}) with open ${p.instrumentKey} in the same direction`);
    }

    const perUnitRisk = Math.abs(sig.entry - sig.stop);
    if (!(perUnitRisk > 0)) return reject('invalid stop distance');
    const equity = this.portfolio.equity();
    const T = this.trading();
    const lev = Math.max(1, leverage);
    checks.equity = equity;
    checks.leverage = lev;
    checks.sizingMode = T.sizingMode;
    checks.metaSize = metaSize;
    checks.gateSize = gate.sizeMultiplier;

    // Liquidation guard: with leverage the stop must sit well inside the liquidation price,
    // otherwise the position can be liquidated before the stop ever triggers.
    if (lev > 1) {
      const liqDist = Math.max(0, 1 / lev - T.maintenanceMargin);
      const stopDist = perUnitRisk / sig.entry;
      checks.liquidationDistancePct = liqDist * 100;
      checks.stopDistancePct = stopDist * 100;
      if (stopDist > liqDist / T.liquidationBuffer) {
        return reject(`stop ${(stopDist * 100).toFixed(2)}% away is too wide for ${lev}x (liquidation ≈ ${(liqDist * 100).toFixed(2)}% away; stop must be within 1/${T.liquidationBuffer} of it)`);
      }
    }

    // Sizing. Risk mode: loss at the stop = riskPerTrade of equity. Margin mode: commit a
    // share of equity as margin at the chosen leverage. Both are capped by the hard
    // max-loss-per-trade at the stop.
    const riskBudget = equity * L.riskPerTrade * gate.sizeMultiplier * metaSize;
    let qty = T.sizingMode === 'margin'
      ? Math.floor((equity * T.marginPerTradePct * lev * gate.sizeMultiplier * metaSize) / sig.entry)
      : Math.floor(riskBudget / perUnitRisk);
    checks.riskBudget = T.sizingMode === 'risk' ? riskBudget : undefined;
    const hardLossQty = Math.floor((equity * T.maxLossPerTradePct) / perUnitRisk);
    if (hardLossQty < qty) reasons.push(`max-loss-per-trade cap ${hardLossQty} (< ${qty})`);
    qty = Math.min(qty, hardLossQty);

    // Participation cap: <= maxParticipation of the typical 1-minute volume.
    const vols = this.quotes.bars(sig.instrumentKey, 30).map((b) => b.volume).sort((a, b) => a - b);
    const medVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
    checks.medianMinuteVolume = medVol;
    if (inst.venue !== 'DELTA') {
      const capQty = Math.floor(L.maxParticipation * medVol);
      if (capQty < qty) reasons.push(`participation cap ${capQty} (< ${qty})`);
      qty = Math.min(qty, capQty);
    }

    // Leverage raises the buying-power ceilings (notional, gross exposure) and the
    // margin actually available; it does not change the loss at the stop.
    const notionalCap = Math.floor((equity * L.maxPositionNotional * lev) / sig.entry);
    if (notionalCap < qty) reasons.push(`notional cap ${notionalCap}`);
    qty = Math.min(qty, notionalCap);

    const marginFree = equity - this.portfolio.marginUsed();
    checks.marginFree = marginFree;
    const marginRoom = Math.floor((Math.max(0, marginFree) * lev) / sig.entry);
    if (marginRoom < qty) reasons.push(`available margin room ${marginRoom}`);
    qty = Math.min(qty, marginRoom);

    const grossRoom = Math.floor((equity * L.maxGrossExposure * lev - this.portfolio.grossExposure()) / sig.entry);
    if (grossRoom < qty) reasons.push(`gross exposure room ${Math.max(0, grossRoom)}`);
    qty = Math.min(qty, Math.max(0, grossRoom));

    const riskRoom = Math.floor((equity * L.maxOpenRisk - this.portfolio.openRisk()) / perUnitRisk);
    if (riskRoom < qty) reasons.push(`open-risk budget room ${Math.max(0, riskRoom)}`);
    qty = Math.min(qty, Math.max(0, riskRoom));

    qty = Math.floor(qty / inst.lotSize) * inst.lotSize;
    if (qty <= 0) return reject('size rounds to zero after caps / lot size');

    // Cost- and tax-aware minimum edge: the target move must clear round-trip costs by 3x
    // (after the 30% VDA haircut for crypto, where losses cannot be set off).
    if (sig.target !== undefined) {
      const rt = feeFor(inst, 'I', 'BUY', sig.entry, qty, now).total + feeFor(inst, 'I', 'SELL', sig.target, qty, now).total;
      const gross = Math.abs(sig.target - sig.entry) * qty;
      const afterTax = inst.venue === 'DELTA' ? gross * 0.7 : gross;
      checks.roundTripCost = rt;
      checks.targetGross = gross;
      if (afterTax < 3 * rt) return reject(`edge too small: target ₹${gross.toFixed(0)} vs round-trip cost ₹${rt.toFixed(0)} (need 3x${inst.venue === 'DELTA' ? ' after 30% VDA tax' : ''})`);
    }

    return { approved: true, qty, reasons, notional: qty * sig.entry, riskAmount: qty * perUnitRisk, checks };
  }
}
