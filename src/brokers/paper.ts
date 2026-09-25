// Paper broker: the same Broker interface as live, filled by the fill simulator
// against live (or synthetic) quotes. Order headers are built exactly as for live
// so compliance wiring is exercised (plan Phase 0 exit criterion), and the OPS
// throttle is applied so paper behaviour matches live pacing.

import type { OrderRequest } from '../core/types.ts';
import { newId } from '../core/ids.ts';
import type { Broker, BrokerOrderState, BrokerPositionState } from './broker.ts';
import { BrokerError } from './broker.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import { simulateFill, DEFAULT_SIM, type MarketSnapshot, type SimOrder, type SimParams } from '../sim/fillSimulator.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import type { OrderThrottle } from './throttle.ts';

interface PaperOrder {
  state: BrokerOrderState;
  sim: SimOrder;
  reduceOnly: boolean;
}

export class PaperBroker implements Broker {
  readonly name = 'paper';
  readonly live = false;
  private orders = new Map<string, PaperOrder>();
  private positions = new Map<string, { qty: number; avgPrice: number }>();
  private updateCbs: ((u: BrokerOrderState) => void)[] = [];
  private fillCbs: Parameters<Broker['onFill']>[0][] = [];
  private headers?: Record<string, string>;
  private quotes: QuoteBook;
  private refdata: InstrumentRegistry;
  private throttle?: OrderThrottle;
  private buildHeaders: () => Record<string, string>;
  private isContinuous: (key: string) => boolean;
  private now: () => number;
  simParams: SimParams;
  /** Backtest mode: new orders wait for the next bar instead of filling on the current quote. */
  deferFills = false;

  constructor(opts: {
    quotes: QuoteBook;
    refdata: InstrumentRegistry;
    throttle?: OrderThrottle;
    buildHeaders: () => Record<string, string>;
    isContinuous: (key: string) => boolean;
    now?: () => number;
    simParams?: SimParams;
  }) {
    this.quotes = opts.quotes;
    this.refdata = opts.refdata;
    this.throttle = opts.throttle;
    this.buildHeaders = opts.buildHeaders;
    this.isContinuous = opts.isContinuous;
    this.now = opts.now ?? Date.now;
    this.simParams = opts.simParams ?? DEFAULT_SIM;
  }

  lastOrderHeaders(): Record<string, string> | undefined {
    return this.headers;
  }

  async placeOrder(req: OrderRequest): Promise<{ brokerOrderId: string }> {
    const inst = this.refdata.byKey(req.instrumentKey);
    if (!inst) throw new BrokerError(`unknown instrument ${req.instrumentKey}`, 'INSTRUMENT', false);
    if (req.qty <= 0 || req.qty % inst.lotSize !== 0) throw new BrokerError(`qty ${req.qty} not a multiple of lot ${inst.lotSize}`, 'LOT', false);
    if ((req.type === 'LIMIT' || req.type === 'SL') && !(req.price && req.price > 0)) throw new BrokerError('limit price required', 'PRICE', false);
    // Build compliance headers exactly as live would; a missing Algo Name is recorded, not fatal, in paper.
    try {
      this.headers = this.buildHeaders();
    } catch (e) {
      this.headers = { 'X-Algo-Name': `<missing: ${String((e as Error).message)}>` };
    }
    await this.throttle?.acquire();
    const id = newId('P');
    const state: BrokerOrderState = {
      brokerOrderId: id, clientOrderId: req.clientOrderId, instrumentKey: req.instrumentKey, side: req.side,
      qty: req.qty, filledQty: 0, avgPrice: 0, status: 'NEW', type: req.type, price: req.price, triggerPrice: req.triggerPrice,
      tag: req.tag, ts: this.now(),
    };
    this.orders.set(id, { state, sim: { side: req.side, qty: req.qty, type: req.type, limit: req.price, trigger: req.triggerPrice, lotSize: inst.lotSize }, reduceOnly: !!req.reduceOnly });
    queueMicrotask(() => {
      this.emit(state);
      if (!this.deferFills) this.tryFill(id);
      if (req.validity === 'IOC') {
        const o = this.orders.get(id);
        if (o && (o.state.status === 'NEW' || o.state.status === 'PARTIALLY_FILLED')) {
          o.state.status = 'CANCELLED';
          o.state.reason = 'IOC remainder cancelled';
          this.emit(o.state);
        }
      }
    });
    return { brokerOrderId: id };
  }

  async modifyOrder(id: string, patch: { qty?: number; price?: number; triggerPrice?: number }): Promise<void> {
    const o = this.orders.get(id);
    if (!o || !this.isOpen(o.state)) throw new BrokerError(`order ${id} not open`, 'NOT_OPEN', false);
    await this.throttle?.acquire();
    if (patch.price !== undefined) { o.state.price = patch.price; o.sim.limit = patch.price; }
    if (patch.triggerPrice !== undefined) { o.state.triggerPrice = patch.triggerPrice; o.sim.trigger = patch.triggerPrice; o.sim.triggered = false; }
    if (patch.qty !== undefined) {
      if (patch.qty < o.state.filledQty) throw new BrokerError('qty below filled', 'QTY', false);
      o.state.qty = patch.qty;
      o.sim.qty = patch.qty - o.state.filledQty;
    }
    this.emit(o.state);
  }

  async cancelOrder(id: string): Promise<void> {
    const o = this.orders.get(id);
    if (!o || !this.isOpen(o.state)) return;
    await this.throttle?.acquire();
    o.state.status = 'CANCELLED';
    this.emit(o.state);
  }

  async getOrders(): Promise<BrokerOrderState[]> {
    return [...this.orders.values()].map((o) => ({ ...o.state }));
  }

  async getPositions(): Promise<BrokerPositionState[]> {
    return [...this.positions.entries()].filter(([, p]) => p.qty !== 0).map(([k, p]) => ({ instrumentKey: k, qty: p.qty, avgPrice: p.avgPrice }));
  }

  onOrderUpdate(cb: (u: BrokerOrderState) => void): void {
    this.updateCbs.push(cb);
  }

  onFill(cb: Parameters<Broker['onFill']>[0]): void {
    this.fillCbs.push(cb);
  }

  /** Rebuild simulated broker positions after a restart (paper mode only). */
  seedPositions(rows: { instrumentKey: string; qty: number; avgPrice: number }[]): void {
    for (const r of rows) {
      const cur = this.positions.get(r.instrumentKey) ?? { qty: 0, avgPrice: 0 };
      const nq = cur.qty + r.qty;
      this.positions.set(r.instrumentKey, { qty: nq, avgPrice: nq ? (cur.avgPrice * cur.qty + r.avgPrice * r.qty) / nq : 0 });
    }
  }

  /**
   * Backtest: work resting orders against a bar's OHLC (orders placed at the previous
   * close meet this bar's open first; no look-ahead).
   */
  onMarketBar(bar: { key: string; open: number; high: number; low: number; close: number; volume: number }): void {
    const inst = this.refdata.byKey(bar.key);
    const base = this.quotes.snapshot(bar.key, inst?.tickSize ?? 0.05, true);
    if (!base) return;
    const snap = { ...base, ltp: bar.open, bid: undefined, ask: undefined, open: bar.open, high: bar.high, low: bar.low, volume1m: bar.volume || base.volume1m };
    for (const [id, o] of this.orders) {
      if (o.state.instrumentKey !== bar.key || !this.isOpen(o.state)) continue;
      this.tryFill(id, snap);
    }
  }

  /** Call on every tick for the instrument (or on a timer) to work resting orders. */
  onMarket(key: string): void {
    for (const [id, o] of this.orders) if (o.state.instrumentKey === key && this.isOpen(o.state)) this.tryFill(id);
  }

  private isOpen(s: BrokerOrderState): boolean {
    return s.status === 'NEW' || s.status === 'PARTIALLY_FILLED' || s.status === 'PENDING_NEW';
  }

  private tryFill(id: string, override?: MarketSnapshot): void {
    const o = this.orders.get(id);
    if (!o || !this.isOpen(o.state)) return;
    const inst = this.refdata.byKey(o.state.instrumentKey);
    const snap = override ?? this.quotes.snapshot(o.state.instrumentKey, inst?.tickSize ?? 0.05, this.isContinuous(o.state.instrumentKey));
    if (!snap) return;
    const r = simulateFill(o.sim, snap, this.simParams);
    o.sim.triggered = r.triggered;
    if (r.rejected) {
      o.state.status = 'REJECTED';
      o.state.reason = r.rejected;
      this.emit(o.state);
      return;
    }
    if (r.fillQty <= 0) return;
    if (o.reduceOnly) {
      // Reduce-only: never increase or flip the position.
      const pos = this.positions.get(o.state.instrumentKey)?.qty ?? 0;
      const reducing = (o.state.side === 'SELL' && pos > 0) || (o.state.side === 'BUY' && pos < 0);
      const room = reducing ? Math.abs(pos) : 0;
      if (room <= 0) {
        o.state.status = 'CANCELLED';
        o.state.reason = 'reduce-only: no position to reduce';
        this.emit(o.state);
        return;
      }
      r.fillQty = Math.min(r.fillQty, room);
    }
    const prevFilled = o.state.filledQty;
    o.state.filledQty += r.fillQty;
    o.state.avgPrice = (o.state.avgPrice * prevFilled + r.fillPrice * r.fillQty) / o.state.filledQty;
    o.sim.qty -= r.fillQty;
    o.state.status = o.state.filledQty >= o.state.qty ? 'FILLED' : 'PARTIALLY_FILLED';
    const reducedToZero = o.reduceOnly && o.state.status !== 'FILLED' && (this.positions.get(o.state.instrumentKey)?.qty ?? 0) + (o.state.side === 'BUY' ? r.fillQty : -r.fillQty) === 0;
    const signed = o.state.side === 'BUY' ? r.fillQty : -r.fillQty;
    const p = this.positions.get(o.state.instrumentKey) ?? { qty: 0, avgPrice: 0 };
    const nq = p.qty + signed;
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) p.avgPrice = (p.avgPrice * Math.abs(p.qty) + r.fillPrice * r.fillQty) / Math.abs(nq);
    else if (Math.sign(nq) !== Math.sign(p.qty) && nq !== 0) p.avgPrice = r.fillPrice;
    p.qty = nq;
    if (nq === 0) p.avgPrice = 0;
    this.positions.set(o.state.instrumentKey, p);
    this.emit(o.state);
    if (reducedToZero) {
      o.state.status = 'CANCELLED';
      o.state.reason = 'reduce-only remainder cancelled (position flat)';
      queueMicrotask(() => this.emit(o.state));
    }
    for (const cb of this.fillCbs) {
      cb({ clientOrderId: o.state.clientOrderId!, brokerOrderId: id, instrumentKey: o.state.instrumentKey, side: o.state.side, qty: r.fillQty, price: r.fillPrice, ts: this.now() });
    }
  }

  private emit(s: BrokerOrderState): void {
    const copy = { ...s };
    for (const cb of this.updateCbs) cb(copy);
  }
}
