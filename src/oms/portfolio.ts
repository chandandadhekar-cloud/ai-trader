// Portfolio accounting: positions per (instrument, strategy), cash, realised and
// unrealised P&L, fees, equity curve, and tax-ledger entries on every closing fill.

import type { Db } from '../db/database.ts';
import type { Fill, Instrument, ProductType, RunMode } from '../core/types.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import { TaxLedger, bucketFor } from '../analytics/taxLedger.ts';
import { indianCharges, deltaCharges, type IndianSegment } from '../sim/fees.ts';
import { istDate } from '../core/clock.ts';

export interface PositionState {
  instrumentKey: string;
  strategyId: string;
  qty: number;
  avgPrice: number;
  realizedPnl: number;
  openedAt: number;
  product: ProductType;
  stopPrice?: number;
  targetPrice?: number;
  timeStopAt?: number;
  protectiveOrderId?: string;
  protectiveConfirmed: boolean;
  entryFees: number;
}

export function feeFor(inst: Instrument, product: ProductType, side: 'BUY' | 'SELL', price: number, qty: number, ts: number, maker = false): { total: number; tds: number } {
  if (inst.venue === 'DELTA') {
    const c = deltaCharges(price * qty, maker ? 'maker' : 'taker', side);
    return { total: c.total, tds: c.tds };
  }
  const seg: IndianSegment = inst.type === 'FUT' ? 'FUT' : inst.type === 'CE' || inst.type === 'PE' ? 'OPT' : product === 'I' ? 'EQ_INTRADAY' : 'EQ_DELIVERY';
  return { total: indianCharges(seg, side, price, qty, istDate(ts)).total, tds: 0 };
}

export class Portfolio {
  private db: Db;
  private quotes: QuoteBook;
  private refdata: InstrumentRegistry;
  readonly mode: RunMode;
  private positions = new Map<string, PositionState>();
  cash: number;
  startingCapital: number;
  feesPaid = 0;
  realized = 0;
  peakEquity: number;
  dayStartEquity: number;
  dayStartDate?: string;
  private tax: TaxLedger;
  closedTrades: { ts: number; strategyId: string; instrumentKey: string; pnl: number; netPnl: number; rMultiple?: number }[] = [];

  constructor(db: Db, quotes: QuoteBook, refdata: InstrumentRegistry, mode: RunMode, capital: number) {
    this.db = db;
    this.quotes = quotes;
    this.refdata = refdata;
    this.mode = mode;
    this.tax = new TaxLedger(db);
    this.startingCapital = capital;
    this.cash = capital;
    this.peakEquity = capital;
    this.dayStartEquity = capital;
    this.load();
  }

  private pk(key: string, strategyId: string): string {
    return `${key}::${strategyId}`;
  }

  get(key: string, strategyId: string): PositionState | undefined {
    return this.positions.get(this.pk(key, strategyId));
  }

  /** Net quantity across strategies for an instrument. */
  netQty(key: string): number {
    let q = 0;
    for (const p of this.positions.values()) if (p.instrumentKey === key) q += p.qty;
    return q;
  }

  byInstrument(key: string): PositionState[] {
    return [...this.positions.values()].filter((p) => p.instrumentKey === key && p.qty !== 0);
  }

  open(): PositionState[] {
    return [...this.positions.values()].filter((p) => p.qty !== 0);
  }

  update(key: string, strategyId: string, patch: Partial<PositionState>): void {
    const p = this.positions.get(this.pk(key, strategyId));
    if (!p) return;
    Object.assign(p, patch);
    this.persist(p);
  }

  applyFill(f: Fill, strategyId: string, product: ProductType, levels?: { stop?: number; target?: number; timeStopMin?: number }): { closedQty: number; pnl: number } {
    const inst = this.refdata.byKey(f.instrumentKey);
    const signed = f.side === 'BUY' ? f.qty : -f.qty;
    const k = this.pk(f.instrumentKey, strategyId);
    let p = this.positions.get(k);
    if (!p) {
      p = { instrumentKey: f.instrumentKey, strategyId, qty: 0, avgPrice: 0, realizedPnl: 0, openedAt: f.ts, product, protectiveConfirmed: false, entryFees: 0 };
      this.positions.set(k, p);
    }
    this.cash -= signed * f.price + f.fees;
    this.feesPaid += f.fees;
    let closedQty = 0;
    let pnl = 0;
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) {
      if (p.qty === 0) {
        p.openedAt = f.ts;
        p.entryFees = 0;
        p.protectiveConfirmed = false;
        p.protectiveOrderId = undefined;
        if (levels) {
          p.stopPrice = levels.stop;
          p.targetPrice = levels.target;
          p.timeStopAt = levels.timeStopMin ? f.ts + levels.timeStopMin * 60_000 : undefined;
        }
      }
      p.avgPrice = (p.avgPrice * Math.abs(p.qty) + f.price * f.qty) / (Math.abs(p.qty) + f.qty);
      p.qty += signed;
      p.entryFees += f.fees;
    } else {
      closedQty = Math.min(Math.abs(p.qty), f.qty);
      const dir = Math.sign(p.qty);
      pnl = dir * (f.price - p.avgPrice) * closedQty;
      p.realizedPnl += pnl;
      this.realized += pnl;
      const entryFeeShare = p.entryFees * (closedQty / Math.abs(p.qty));
      p.entryFees -= entryFeeShare;
      const exitFees = f.fees * (closedQty / f.qty);
      const buyValue = dir > 0 ? p.avgPrice * closedQty : f.price * closedQty;
      const sellValue = dir > 0 ? f.price * closedQty : p.avgPrice * closedQty;
      if (inst) {
        const holdingDays = (f.ts - p.openedAt) / 86400_000;
        const tds = inst.venue === 'DELTA' ? feeFor(inst, product, 'SELL', sellValue / closedQty, closedQty, f.ts).tds : 0;
        this.tax.record({ ts: f.ts, bucket: bucketFor(inst, p.product, holdingDays), instrumentKey: f.instrumentKey, qty: closedQty, buyValue, sellValue, charges: entryFeeShare + exitFees, tds, strategyId, mode: this.mode });
      }
      const risk = p.stopPrice !== undefined ? Math.abs(p.avgPrice - p.stopPrice) * closedQty : undefined;
      this.closedTrades.push({ ts: f.ts, strategyId, instrumentKey: f.instrumentKey, pnl, netPnl: pnl - entryFeeShare - exitFees, rMultiple: risk ? pnl / risk : undefined });
      if (this.closedTrades.length > 5000) this.closedTrades.shift();
      p.qty += signed;
      const remaining = f.qty - closedQty;
      if (p.qty === 0) {
        p.avgPrice = 0;
        p.stopPrice = p.targetPrice = p.timeStopAt = undefined;
        p.protectiveOrderId = undefined;
        p.protectiveConfirmed = false;
      } else if (remaining > 0) {
        // Flipped through zero: the remainder opens a new position at the fill price.
        p.avgPrice = f.price;
        p.openedAt = f.ts;
      }
    }
    this.persist(p);
    return { closedQty, pnl };
  }

  mark(key: string): number | undefined {
    return this.quotes.ltp(key);
  }

  unrealized(): number {
    let u = 0;
    for (const p of this.positions.values()) {
      if (!p.qty) continue;
      const px = this.mark(p.instrumentKey) ?? p.avgPrice;
      u += (px - p.avgPrice) * p.qty;
    }
    return u;
  }

  grossExposure(): number {
    let g = 0;
    for (const p of this.positions.values()) if (p.qty) g += Math.abs(p.qty * (this.mark(p.instrumentKey) ?? p.avgPrice));
    return g;
  }

  /** Sum of distance-to-stop x qty (money at risk if every stop fills at its price). */
  openRisk(): number {
    let r = 0;
    for (const p of this.positions.values()) {
      if (!p.qty) continue;
      const px = this.mark(p.instrumentKey) ?? p.avgPrice;
      r += p.stopPrice !== undefined ? Math.max(0, (px - p.stopPrice) * p.qty) : Math.abs(px * p.qty) * 0.05;
    }
    return r;
  }

  equity(): number {
    // Cash already includes the cost of open positions; add their market value.
    let mv = 0;
    for (const p of this.positions.values()) if (p.qty) mv += p.qty * (this.mark(p.instrumentKey) ?? p.avgPrice);
    return this.cash + mv;
  }

  /** Update peaks and the day-start reference; returns drawdown and day P&L fractions. */
  refresh(now: number): { equity: number; drawdown: number; dayPnlPct: number } {
    const eq = this.equity();
    const d = istDate(now);
    if (this.dayStartDate !== d) {
      this.dayStartDate = d;
      this.dayStartEquity = eq;
    }
    this.peakEquity = Math.max(this.peakEquity, eq);
    return { equity: eq, drawdown: this.peakEquity > 0 ? (this.peakEquity - eq) / this.peakEquity : 0, dayPnlPct: this.dayStartEquity > 0 ? (eq - this.dayStartEquity) / this.dayStartEquity : 0 };
  }

  snapshot(now: number): void {
    const eq = this.equity();
    this.db.run('INSERT OR REPLACE INTO equity_curve (ts, mode, equity, cash, open_risk, gross_exposure) VALUES (?,?,?,?,?,?)', now - (now % 60_000), this.mode, eq, this.cash, this.openRisk(), this.grossExposure());
  }

  private persist(p: PositionState): void {
    this.db.run(
      `INSERT INTO positions (instrument_key, strategy_id, qty, avg_price, realized_pnl, opened_at, stop_price, target_price, time_stop_at, protective_order_id, protective_confirmed, mode, product)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instrument_key, strategy_id, mode) DO UPDATE SET qty=excluded.qty, avg_price=excluded.avg_price,
       realized_pnl=excluded.realized_pnl, opened_at=excluded.opened_at, stop_price=excluded.stop_price, target_price=excluded.target_price,
       time_stop_at=excluded.time_stop_at, protective_order_id=excluded.protective_order_id, protective_confirmed=excluded.protective_confirmed, product=excluded.product`,
      p.instrumentKey, p.strategyId, p.qty, p.avgPrice, p.realizedPnl, p.openedAt, p.stopPrice ?? null, p.targetPrice ?? null, p.timeStopAt ?? null, p.protectiveOrderId ?? null, p.protectiveConfirmed ? 1 : 0, this.mode, p.product,
    );
    const st = { cash: this.cash, feesPaid: this.feesPaid, realized: this.realized, peakEquity: this.peakEquity, startingCapital: this.startingCapital };
    this.db.run("INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?, 'system') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", `portfolio_${this.mode}`, JSON.stringify(st), Date.now());
  }

  private load(): void {
    const st = this.db.get<{ value: string }>('SELECT value FROM kv_settings WHERE key = ?', `portfolio_${this.mode}`);
    if (st) {
      const v = JSON.parse(st.value);
      this.cash = v.cash;
      this.feesPaid = v.feesPaid;
      this.realized = v.realized;
      this.peakEquity = v.peakEquity;
      this.startingCapital = v.startingCapital ?? this.startingCapital;
    }
    for (const r of this.db.all<Record<string, any>>('SELECT * FROM positions WHERE mode = ? AND qty != 0', this.mode)) {
      this.positions.set(this.pk(r.instrument_key, r.strategy_id), {
        instrumentKey: r.instrument_key, strategyId: r.strategy_id, qty: r.qty, avgPrice: r.avg_price, realizedPnl: r.realized_pnl, openedAt: r.opened_at,
        product: (r.product ?? 'I') as ProductType, stopPrice: r.stop_price ?? undefined, targetPrice: r.target_price ?? undefined, timeStopAt: r.time_stop_at ?? undefined,
        protectiveOrderId: r.protective_order_id ?? undefined, protectiveConfirmed: !!r.protective_confirmed, entryFees: 0,
      });
    }
  }

  /** Reset paper account (admin action). */
  reset(capital: number): void {
    this.positions.clear();
    this.cash = capital;
    this.startingCapital = capital;
    this.peakEquity = capital;
    this.dayStartEquity = capital;
    this.feesPaid = 0;
    this.realized = 0;
    this.closedTrades = [];
    this.db.run('DELETE FROM positions WHERE mode = ?', this.mode);
    this.db.run("INSERT INTO kv_settings (key, value, updated_at, updated_by) VALUES (?,?,?, 'system') ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", `portfolio_${this.mode}`, JSON.stringify({ cash: capital, feesPaid: 0, realized: 0, peakEquity: capital, startingCapital: capital }), Date.now());
  }
}
