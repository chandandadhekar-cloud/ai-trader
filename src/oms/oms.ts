// Order management (plan §P0.6):
//  - idempotency: client order ids are derived from the signal, stored with a
//    primary key; the same id never reaches the broker twice
//  - entries are marketable LIMIT orders with price protection (no API market orders)
//  - broker-side protective stop placed on every entry fill and resized on partial
//    fills; a trade counts as "open" only once the stop is acknowledged by the broker.
//    If the stop cannot be placed/confirmed, the position is flattened and a P0 fires
//  - reconciliation against the broker at startup and periodically; new entries are
//    blocked until the books agree

import type { Fill, Instrument, OrderRequest, OrderStatus, ProductType, RunMode, Side, Signal } from '../core/types.ts';
import type { Broker, BrokerOrderState } from '../brokers/broker.ts';
import type { Db } from '../db/database.ts';
import type { EventBus } from '../core/events.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { AuditLog } from '../governance/auditLog.ts';
import { Portfolio, feeFor } from './portfolio.ts';
import { canTransition, isOpenStatus } from './stateMachine.ts';
import { roundToTick } from '../surveillance/bands.ts';
import { sha256 } from '../core/ids.ts';
import { createLogger } from '../core/logger.ts';
import { istDate } from '../core/clock.ts';

const log = createLogger('oms');

export type OrderPurpose = 'entry' | 'protective' | 'exit';

export interface OmsOrder {
  clientOrderId: string;
  brokerOrderId?: string;
  strategyId: string;
  instrumentKey: string;
  side: Side;
  qty: number;
  filledQty: number;
  avgFillPrice?: number;
  type: OrderRequest['type'];
  price?: number;
  triggerPrice?: number;
  product: ProductType;
  status: OrderStatus;
  purpose: OrderPurpose;
  parentId?: string;
  reason?: string;
  createdAt: number;
  levels?: { stop?: number; target?: number; timeStopMin?: number };
}

export interface ReconcileReport {
  at: number;
  ok: boolean;
  positionMismatches: { instrumentKey: string; local: number; broker: number }[];
  orphanBrokerOrders: string[];
  missingLocalOrders: string[];
}

export class Oms {
  private broker: Broker;
  private db: Db;
  private bus: EventBus;
  private refdata: InstrumentRegistry;
  private quotes: QuoteBook;
  private audit: AuditLog;
  readonly portfolio: Portfolio;
  readonly mode: RunMode;
  private orders = new Map<string, OmsOrder>();
  private byBrokerId = new Map<string, string>();
  private now: () => number;
  private algoName?: string;
  reconciled = false;
  lastReconcile?: ReconcileReport;
  entryTimeoutMs = 30_000;
  /** Wall-clock timers (entry timeout, stop confirmation). Disabled in backtests, which expire orders by bar count. */
  useTimers = true;
  protectiveConfirmTimeoutMs = 5_000;
  priceProtectionBps = 30;
  stopLimitBufferBps = 50;
  onTradeClosed?: (strategyId: string, netPnl: number, date: string) => void;
  stats = { submitted: 0, rejected: 0, filled: 0, cancelled: 0, protectiveFailures: 0, duplicateBlocked: 0, rejectReasons: {} as Record<string, number>, lastAckLatencyMs: 0 };
  private submitTimes = new Map<string, number>();

  constructor(opts: { broker: Broker; db: Db; bus: EventBus; refdata: InstrumentRegistry; quotes: QuoteBook; audit: AuditLog; portfolio: Portfolio; mode: RunMode; algoName?: string; now?: () => number }) {
    this.broker = opts.broker;
    this.db = opts.db;
    this.bus = opts.bus;
    this.refdata = opts.refdata;
    this.quotes = opts.quotes;
    this.audit = opts.audit;
    this.portfolio = opts.portfolio;
    this.mode = opts.mode;
    this.algoName = opts.algoName;
    this.now = opts.now ?? Date.now;
    this.broker.onOrderUpdate((u) => this.onBrokerUpdate(u));
    this.broker.onFill((f) => this.onBrokerFill(f));
    this.loadOpenOrders();
  }

  static clientOrderIdFor(sig: Pick<Signal, 'strategyId' | 'instrumentKey' | 'side' | 'ts'>, purpose: OrderPurpose = 'entry', n = 0): string {
    return `TA${sha256(`${sig.strategyId}|${sig.instrumentKey}|${sig.side}|${sig.ts}|${purpose}|${n}`).slice(0, 18)}`;
  }

  openOrders(): OmsOrder[] {
    return [...this.orders.values()].filter((o) => isOpenStatus(o.status));
  }

  recentOrders(limit = 200): Record<string, unknown>[] {
    return this.db.all('SELECT * FROM orders WHERE mode = ? ORDER BY created_at DESC LIMIT ?', this.mode, limit);
  }

  /** Marketable limit: cross the spread by a protection margin, clamp to band. */
  marketablePrice(inst: Instrument, side: Side, bps = this.priceProtectionBps): number | undefined {
    const q = this.quotes.get(inst.key);
    const ltp = q?.last?.ltp;
    if (!ltp) return undefined;
    const ref = side === 'BUY' ? q.last!.ask ?? ltp : q.last!.bid ?? ltp;
    let px = side === 'BUY' ? ref * (1 + bps / 1e4) : ref * (1 - bps / 1e4);
    if (q.band) px = Math.min(Math.max(px, q.band.lower), q.band.upper);
    return roundToTick(px, inst.tickSize, side === 'BUY' ? 'up' : 'down');
  }

  private persist(o: OmsOrder): void {
    this.db.run(
      `INSERT INTO orders (client_order_id, broker_order_id, strategy_id, instrument_key, side, qty, filled_qty, avg_fill_price, order_type, price, trigger_price, product, validity, status, reason, purpose, parent_id, mode, algo_name, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(client_order_id) DO UPDATE SET broker_order_id=excluded.broker_order_id, filled_qty=excluded.filled_qty, avg_fill_price=excluded.avg_fill_price,
       status=excluded.status, reason=excluded.reason, qty=excluded.qty, price=excluded.price, trigger_price=excluded.trigger_price, updated_at=excluded.updated_at`,
      o.clientOrderId, o.brokerOrderId ?? null, o.strategyId, o.instrumentKey, o.side, o.qty, o.filledQty, o.avgFillPrice ?? null, o.type, o.price ?? null,
      o.triggerPrice ?? null, o.product, 'DAY', o.status, o.reason ?? null, o.purpose, o.parentId ?? null, this.mode, this.algoName ?? null, o.createdAt, this.now(),
    );
  }

  private exists(clientOrderId: string): boolean {
    return this.orders.has(clientOrderId) || !!this.db.get('SELECT 1 FROM orders WHERE client_order_id = ?', clientOrderId);
  }

  private async send(o: OmsOrder): Promise<OmsOrder> {
    if (this.exists(o.clientOrderId)) {
      this.stats.duplicateBlocked++;
      log.warn('duplicate client order id blocked', { id: o.clientOrderId });
      return this.orders.get(o.clientOrderId) ?? o;
    }
    this.orders.set(o.clientOrderId, o);
    this.persist(o);
    this.stats.submitted++;
    this.submitTimes.set(o.clientOrderId, this.now());
    try {
      const { brokerOrderId } = await this.broker.placeOrder({
        clientOrderId: o.clientOrderId, instrumentKey: o.instrumentKey, side: o.side, qty: o.qty, type: o.type, price: o.price,
        triggerPrice: o.triggerPrice, product: o.product, validity: 'DAY', strategyId: o.strategyId, tag: o.clientOrderId, reduceOnly: o.purpose !== 'entry',
      });
      o.brokerOrderId = brokerOrderId;
      this.byBrokerId.set(brokerOrderId, o.clientOrderId);
      if (o.status === 'PENDING_NEW') o.status = 'NEW';
      this.persist(o);
    } catch (e) {
      o.status = 'REJECTED';
      o.reason = String((e as Error).message ?? e);
      this.stats.rejected++;
      const code = (e as { code?: string }).code ?? 'ERROR';
      this.stats.rejectReasons[code] = (this.stats.rejectReasons[code] ?? 0) + 1;
      this.persist(o);
      this.bus.publish('order.update', { clientOrderId: o.clientOrderId, status: o.status, reason: o.reason, strategyId: o.strategyId, instrumentKey: o.instrumentKey });
      if (o.purpose === 'protective') await this.protectiveFailed(o, o.reason);
    }
    return o;
  }

  /** Submit an approved entry. Returns undefined if no price is available. */
  async submitEntry(sig: Signal, qty: number, inst: Instrument, product: ProductType = 'I'): Promise<OmsOrder | undefined> {
    const px = this.marketablePrice(inst, sig.side);
    if (!px) return undefined;
    const o: OmsOrder = {
      clientOrderId: Oms.clientOrderIdFor(sig), strategyId: sig.strategyId, instrumentKey: sig.instrumentKey, side: sig.side, qty, filledQty: 0,
      type: 'LIMIT', price: px, product, status: 'PENDING_NEW', purpose: 'entry', createdAt: this.now(),
      levels: { stop: sig.stop, target: sig.target, timeStopMin: sig.timeStopMin },
    };
    this.audit.append('oms', 'order.entry', o.clientOrderId, { sig: { ...sig }, qty, price: px, algoName: this.algoName, mode: this.mode });
    const sent = await this.send(o);
    // Cancel any unfilled remainder after the entry timeout.
    if (this.useTimers) setTimeout(() => {
      const cur = this.orders.get(o.clientOrderId);
      if (cur && isOpenStatus(cur.status) && cur.brokerOrderId) void this.cancel(cur.clientOrderId, 'entry timeout');
    }, this.entryTimeoutMs).unref?.();
    return sent;
  }

  async cancel(clientOrderId: string, reason: string): Promise<void> {
    const o = this.orders.get(clientOrderId);
    if (!o || !o.brokerOrderId || !isOpenStatus(o.status)) return;
    try {
      o.reason = reason;
      await this.broker.cancelOrder(o.brokerOrderId);
    } catch (e) {
      log.warn('cancel failed', { clientOrderId, err: String(e) });
    }
  }

  private stopOrderFor(posQty: number, stop: number, inst: Instrument): { side: Side; trigger: number; limit: number } {
    const side: Side = posQty > 0 ? 'SELL' : 'BUY';
    const trigger = roundToTick(stop, inst.tickSize, side === 'SELL' ? 'down' : 'up');
    const buf = Math.max(trigger * (this.stopLimitBufferBps / 1e4), inst.tickSize * 5);
    let limit = side === 'SELL' ? trigger - buf : trigger + buf;
    const band = this.quotes.get(inst.key)?.band;
    if (band) limit = Math.min(Math.max(limit, band.lower), band.upper);
    return { side, trigger, limit: roundToTick(limit, inst.tickSize, side === 'SELL' ? 'down' : 'up') };
  }

  /** Place or resize the broker-side protective stop for a position. */
  async ensureProtective(key: string, strategyId: string, n: number): Promise<void> {
    const p = this.portfolio.get(key, strategyId);
    const inst = this.refdata.byKey(key);
    if (!p || !p.qty || !inst || p.stopPrice === undefined) return;
    const existing = p.protectiveOrderId ? this.orders.get(p.protectiveOrderId) : undefined;
    const qty = Math.abs(p.qty);
    if (existing && isOpenStatus(existing.status)) {
      if (existing.qty !== qty && existing.brokerOrderId) {
        try {
          await this.broker.modifyOrder(existing.brokerOrderId, { qty });
          existing.qty = qty;
          this.persist(existing);
        } catch (e) {
          await this.protectiveFailed(existing, `resize failed: ${String(e)}`);
        }
      }
      return;
    }
    const s = this.stopOrderFor(p.qty, p.stopPrice, inst);
    const o: OmsOrder = {
      clientOrderId: `TA${sha256(`${key}|${strategyId}|protective|${p.openedAt}|${n}|${this.now()}`).slice(0, 18)}`,
      strategyId, instrumentKey: key, side: s.side, qty, filledQty: 0, type: 'SL', price: s.limit, triggerPrice: s.trigger,
      product: p.product, status: 'PENDING_NEW', purpose: 'protective', createdAt: this.now(),
    };
    this.portfolio.update(key, strategyId, { protectiveOrderId: o.clientOrderId, protectiveConfirmed: false });
    await this.send(o);
    if (this.useTimers) setTimeout(() => {
      const pos = this.portfolio.get(key, strategyId);
      if (pos && pos.qty && pos.protectiveOrderId === o.clientOrderId && !pos.protectiveConfirmed) {
        void this.protectiveFailed(o, 'protective stop not confirmed by broker in time');
      }
    }, this.protectiveConfirmTimeoutMs).unref?.();
  }

  private async protectiveFailed(o: OmsOrder, reason: string): Promise<void> {
    this.stats.protectiveFailures++;
    this.bus.publish('alert', { severity: 'P0', title: 'Protective stop failed', message: `${o.instrumentKey} (${o.strategyId}): ${reason}. Flattening.`, ts: this.now() });
    this.audit.append('oms', 'protective.failed', o.clientOrderId, { reason });
    await this.exitPosition(o.instrumentKey, o.strategyId, `protective failure: ${reason}`);
  }

  /** Flatten a strategy's position with a marketable limit (reduce-only). */
  async exitPosition(key: string, strategyId: string, reason: string, n = 0): Promise<OmsOrder | undefined> {
    const p = this.portfolio.get(key, strategyId);
    const inst = this.refdata.byKey(key);
    if (!p || !p.qty || !inst) return undefined;
    // Cancel working exits for this position first (not the protective stop yet: it stays until the exit fills).
    for (const o of this.openOrders()) if (o.instrumentKey === key && o.strategyId === strategyId && o.purpose === 'exit') await this.cancel(o.clientOrderId, 'superseded');
    const side: Side = p.qty > 0 ? 'SELL' : 'BUY';
    const px = this.marketablePrice(inst, side, this.priceProtectionBps * 2);
    if (!px) {
      this.bus.publish('alert', { severity: 'P1', title: 'Exit without price', message: `${key}: no quote to price exit (${reason})`, ts: this.now() });
      return undefined;
    }
    const o: OmsOrder = {
      clientOrderId: `TA${sha256(`${key}|${strategyId}|exit|${p.openedAt}|${n}|${this.now()}`).slice(0, 18)}`,
      strategyId, instrumentKey: key, side, qty: Math.abs(p.qty), filledQty: 0, type: 'LIMIT', price: px, product: p.product,
      status: 'PENDING_NEW', purpose: 'exit', createdAt: this.now(), reason,
    };
    this.audit.append('oms', 'order.exit', o.clientOrderId, { key, strategyId, reason, qty: o.qty, price: px });
    return this.send(o);
  }

  async flattenAll(reason: string): Promise<void> {
    for (const o of this.openOrders()) if (o.purpose === 'entry') await this.cancel(o.clientOrderId, reason);
    for (const p of this.portfolio.open()) await this.exitPosition(p.instrumentKey, p.strategyId, reason);
  }

  async modifyStop(key: string, strategyId: string, newStop: number, reason: string): Promise<void> {
    const p = this.portfolio.get(key, strategyId);
    const inst = this.refdata.byKey(key);
    if (!p || !p.qty || !inst) return;
    this.portfolio.update(key, strategyId, { stopPrice: newStop });
    const o = p.protectiveOrderId ? this.orders.get(p.protectiveOrderId) : undefined;
    if (o?.brokerOrderId && isOpenStatus(o.status)) {
      const s = this.stopOrderFor(p.qty, newStop, inst);
      try {
        await this.broker.modifyOrder(o.brokerOrderId, { triggerPrice: s.trigger, price: s.limit });
        o.triggerPrice = s.trigger;
        o.price = s.limit;
        this.persist(o);
        this.audit.append('oms', 'protective.modify', o.clientOrderId, { newStop, reason });
      } catch (e) {
        await this.protectiveFailed(o, `modify failed: ${String(e)}`);
      }
    }
  }

  // ---- broker callbacks ------------------------------------------------------

  private onBrokerUpdate(u: BrokerOrderState): void {
    const id = u.clientOrderId && this.orders.has(u.clientOrderId) ? u.clientOrderId : this.byBrokerId.get(u.brokerOrderId);
    if (!id) return;
    const o = this.orders.get(id)!;
    if (!o.brokerOrderId) {
      o.brokerOrderId = u.brokerOrderId;
      this.byBrokerId.set(u.brokerOrderId, id);
    }
    if (!canTransition(o.status, u.status)) {
      log.warn('illegal order transition ignored', { id, from: o.status, to: u.status });
      return;
    }
    const t0 = this.submitTimes.get(id);
    if (t0 && o.status === 'PENDING_NEW') {
      this.stats.lastAckLatencyMs = this.now() - t0;
      this.submitTimes.delete(id);
    }
    o.status = u.status;
    if (u.reason) o.reason = u.reason;
    if (u.status === 'CANCELLED') this.stats.cancelled++;
    this.persist(o);
    this.bus.publish('order.update', { clientOrderId: id, status: o.status, brokerOrderId: u.brokerOrderId, reason: o.reason, strategyId: o.strategyId, instrumentKey: o.instrumentKey });

    if (o.purpose === 'protective') {
      const p = this.portfolio.get(o.instrumentKey, o.strategyId);
      if (p && p.protectiveOrderId === id) {
        if (u.status === 'NEW' || u.status === 'PARTIALLY_FILLED') {
          if (!p.protectiveConfirmed) {
            this.portfolio.update(o.instrumentKey, o.strategyId, { protectiveConfirmed: true });
            this.bus.publish('position.update', { instrumentKey: o.instrumentKey, qty: p.qty, avgPrice: p.avgPrice, strategyId: o.strategyId });
          }
        } else if ((u.status === 'CANCELLED' || u.status === 'REJECTED' || u.status === 'EXPIRED') && p.qty !== 0) {
          // Exchange-cancelled stop (e.g. CAS start at 15:15) while still positioned.
          void this.protectiveFailed(o, `protective ${u.status.toLowerCase()} by broker/exchange${u.reason ? `: ${u.reason}` : ''}`);
        }
      }
    }
  }

  private onBrokerFill(f: Omit<Fill, 'fees'>): void {
    const id = this.orders.has(f.clientOrderId) ? f.clientOrderId : this.byBrokerId.get(f.brokerOrderId);
    if (!id) {
      log.warn('fill for unknown order', { ...f });
      return;
    }
    const o = this.orders.get(id)!;
    const inst = this.refdata.byKey(o.instrumentKey);
    const fees = inst ? feeFor(inst, o.product, f.side, f.price, f.qty, f.ts, o.purpose === 'protective').total : 0;
    const prevFilled = o.filledQty;
    o.filledQty += f.qty;
    o.avgFillPrice = ((o.avgFillPrice ?? 0) * prevFilled + f.price * f.qty) / o.filledQty;
    this.persist(o);
    this.stats.filled++;
    const fill: Fill = { ...f, clientOrderId: id, fees };
    this.db.run('INSERT INTO fills (client_order_id, broker_order_id, instrument_key, side, qty, price, fees, ts, strategy_id, mode) VALUES (?,?,?,?,?,?,?,?,?,?)', id, f.brokerOrderId, f.instrumentKey, f.side, f.qty, f.price, fees, f.ts, o.strategyId, this.mode);
    const before = this.portfolio.get(o.instrumentKey, o.strategyId)?.realizedPnl ?? 0;
    const r = this.portfolio.applyFill(fill, o.strategyId, o.product, o.purpose === 'entry' ? o.levels : undefined);
    this.bus.publish('fill', fill);
    const p = this.portfolio.get(o.instrumentKey, o.strategyId);
    this.bus.publish('position.update', { instrumentKey: o.instrumentKey, qty: p?.qty ?? 0, avgPrice: p?.avgPrice ?? 0, strategyId: o.strategyId });

    if (o.purpose === 'entry') {
      void this.ensureProtective(o.instrumentKey, o.strategyId, o.filledQty);
    } else if (p && p.qty === 0) {
      // Position closed: cancel remaining protective / exit orders for it.
      for (const x of this.openOrders()) if (x.instrumentKey === o.instrumentKey && x.strategyId === o.strategyId) void this.cancel(x.clientOrderId, 'position closed');
      const realizedDelta = (p.realizedPnl ?? 0) - before;
      this.onTradeClosed?.(o.strategyId, realizedDelta, istDate(f.ts));
    } else if (p && r.closedQty > 0) {
      const flipped = (o.side === 'SELL' && p.qty < 0) || (o.side === 'BUY' && p.qty > 0);
      if (flipped) {
        // A reducing order over-filled (e.g. stop and exit both filled): flatten the flip.
        this.bus.publish('alert', { severity: 'P0', title: 'Position over-filled', message: `${o.instrumentKey} (${o.strategyId}) flipped to ${p.qty} after ${o.purpose} fill; flattening`, ts: this.now() });
        void this.exitPosition(o.instrumentKey, o.strategyId, 'over-fill correction', 1);
      } else {
        void this.ensureProtective(o.instrumentKey, o.strategyId, o.filledQty);
      }
    }
  }

  // ---- reconciliation --------------------------------------------------------

  async reconcile(): Promise<ReconcileReport> {
    const rep: ReconcileReport = { at: this.now(), ok: true, positionMismatches: [], orphanBrokerOrders: [], missingLocalOrders: [] };
    try {
      const [bOrders, bPos] = await Promise.all([this.broker.getOrders(), this.broker.getPositions()]);
      const bOpen = new Map(bOrders.filter((o) => isOpenStatus(o.status)).map((o) => [o.brokerOrderId, o]));
      for (const o of this.openOrders()) {
        if (!o.brokerOrderId) continue;
        const b = bOrders.find((x) => x.brokerOrderId === o.brokerOrderId);
        if (!b) {
          rep.missingLocalOrders.push(o.clientOrderId);
          o.status = 'CANCELLED';
          o.reason = 'reconcile: not found at broker';
          this.persist(o);
        } else if (b.status !== o.status && canTransition(o.status, b.status)) {
          o.status = b.status;
          this.persist(o);
        }
      }
      for (const [bid, b] of bOpen) {
        if (!this.byBrokerId.has(bid) && !(b.clientOrderId && this.orders.has(b.clientOrderId))) rep.orphanBrokerOrders.push(bid);
      }
      const keys = new Set([...bPos.map((p) => p.instrumentKey), ...this.portfolio.open().map((p) => p.instrumentKey)]);
      for (const k of keys) {
        const local = this.portfolio.netQty(k);
        const broker = bPos.filter((p) => p.instrumentKey === k).reduce((a, p) => a + p.qty, 0);
        if (local !== broker) rep.positionMismatches.push({ instrumentKey: k, local, broker });
      }
      rep.ok = rep.positionMismatches.length === 0 && rep.orphanBrokerOrders.length === 0;
    } catch (e) {
      rep.ok = false;
      log.error('reconcile failed', { err: String(e) });
    }
    this.reconciled = rep.ok;
    this.lastReconcile = rep;
    this.audit.append('oms', 'reconcile', null, rep);
    if (!rep.ok) this.bus.publish('alert', { severity: 'P1', title: 'Reconciliation mismatch', message: JSON.stringify({ positions: rep.positionMismatches, orphans: rep.orphanBrokerOrders.length }), ts: this.now() });
    else {
      // Books agree: make sure every open position has a live broker-side stop.
      for (const p of this.portfolio.open()) {
        const po = p.protectiveOrderId ? this.orders.get(p.protectiveOrderId) : undefined;
        if (!po || !isOpenStatus(po.status)) void this.ensureProtective(p.instrumentKey, p.strategyId, 0);
      }
    }
    return rep;
  }

  /** Operator acknowledgement after manual resolution of a mismatch. */
  acknowledgeReconcile(by: string, note: string): void {
    this.reconciled = true;
    this.audit.append(by, 'reconcile.acknowledge', null, { note, report: this.lastReconcile });
  }

  private loadOpenOrders(): void {
    const rows = this.db.all<Record<string, any>>("SELECT * FROM orders WHERE mode = ? AND status IN ('PENDING_NEW','NEW','PARTIALLY_FILLED','PENDING_CANCEL')", this.mode);
    for (const r of rows) {
      const o: OmsOrder = {
        clientOrderId: r.client_order_id, brokerOrderId: r.broker_order_id ?? undefined, strategyId: r.strategy_id, instrumentKey: r.instrument_key,
        side: r.side, qty: r.qty, filledQty: r.filled_qty, avgFillPrice: r.avg_fill_price ?? undefined, type: r.order_type, price: r.price ?? undefined,
        triggerPrice: r.trigger_price ?? undefined, product: r.product, status: r.status, purpose: r.purpose, parentId: r.parent_id ?? undefined,
        reason: r.reason ?? undefined, createdAt: r.created_at,
      };
      this.orders.set(o.clientOrderId, o);
      if (o.brokerOrderId) this.byBrokerId.set(o.brokerOrderId, o.clientOrderId);
    }
  }
}
