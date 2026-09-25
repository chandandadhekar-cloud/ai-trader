// Delta Exchange India REST client (crypto perpetuals, INR-settled).
// Auth: HMAC-SHA256 over method + timestamp + path + query + body with headers
// `api-key`, `timestamp` (unix seconds), `signature`. Signatures expire after a few
// seconds, so the local clock must be NTP-synced.
// Use withdrawal-disabled, IP-whitelisted keys (plan §16).
// Dead-man switch: cancel-after timer refreshed by heartbeat() — if the process
// dies, the venue cancels open orders. Verify endpoint names and India-specific
// limits with Delta support before going live (plan caveats).

import { createHmac } from 'node:crypto';
import type { OrderRequest, Side } from '../../core/types.ts';
import { createLogger } from '../../core/logger.ts';
import { BrokerError, type Broker, type BrokerOrderState, type BrokerPositionState } from '../broker.ts';
import { SlidingWindowLimiter } from '../throttle.ts';

const log = createLogger('delta');

export function deltaSignature(secret: string, method: string, timestamp: string, path: string, query: string, body: string): string {
  return createHmac('sha256', secret).update(method + timestamp + path + query + body).digest('hex');
}

export interface DeltaTicker {
  symbol: string;
  product_id: number;
  mark_price: string;
  spot_price?: string;
  close?: number;
  volume?: number;
  oi?: string;
  funding_rate?: string;
  timestamp?: number;
  quotes?: { best_bid?: string; best_ask?: string };
}

export class DeltaClient implements Broker {
  readonly name = 'delta';
  readonly live: boolean;
  private base: string;
  private key?: string;
  private secret?: string;
  private deadmanMs: number;
  private limiter = new SlidingWindowLimiter([{ ms: 1000, max: 10 }, { ms: 5 * 60_000, max: 2000 }]);
  private productIds = new Map<string, number>();
  private updateCbs: ((u: BrokerOrderState) => void)[] = [];
  private fillCbs: Parameters<Broker['onFill']>[0][] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: { base: string; key?: string; secret?: string; live: boolean; deadmanMs: number }, fetchImpl: typeof fetch = fetch) {
    this.base = opts.base.replace(/\/$/, '');
    this.key = opts.key;
    this.secret = opts.secret;
    this.live = opts.live;
    this.deadmanMs = opts.deadmanMs;
    this.fetchImpl = fetchImpl;
  }

  configured(): boolean {
    return !!(this.key && this.secret);
  }

  private async call<T>(method: string, path: string, query: Record<string, string | number> = {}, body?: unknown, auth = true): Promise<T> {
    await this.limiter.acquire(5_000);
    const qs = Object.keys(query).length ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : '';
    const b = body !== undefined ? JSON.stringify(body) : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'tradeai/0.1' };
    if (auth) {
      if (!this.key || !this.secret) throw new BrokerError('Delta API key/secret not configured', 'AUTH', false);
      const ts = Math.floor(Date.now() / 1000).toString();
      headers['api-key'] = this.key;
      headers['timestamp'] = ts;
      headers['signature'] = deltaSignature(this.secret, method, ts, path, qs, b);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path + qs, { method, headers, body: b || undefined, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new BrokerError(`delta network error ${method} ${path}: ${String(e)}`, 'NETWORK', true);
    }
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; error?: { code?: string; context?: unknown } };
    if (!res.ok || j.success === false) {
      throw new BrokerError(`delta ${method} ${path} → ${res.status} ${j.error?.code ?? ''} ${JSON.stringify(j.error?.context ?? '')}`, j.error?.code ?? `HTTP_${res.status}`, res.status === 429 || res.status >= 500, res.status);
    }
    return j.result as T;
  }

  async loadProducts(): Promise<number> {
    const rows = await this.call<{ id: number; symbol: string; contract_type: string }[]>('GET', '/v2/products', { contract_types: 'perpetual_futures' }, undefined, false);
    for (const p of rows) this.productIds.set(p.symbol, p.id);
    return rows.length;
  }

  async tickers(): Promise<DeltaTicker[]> {
    return this.call<DeltaTicker[]>('GET', '/v2/tickers', { contract_types: 'perpetual_futures' }, undefined, false);
  }

  private productId(key: string): number {
    const id = this.productIds.get(key);
    if (id === undefined) throw new BrokerError(`unknown Delta product ${key}; call loadProducts()`, 'PRODUCT', false);
    return id;
  }

  async placeOrder(req: OrderRequest): Promise<{ brokerOrderId: string }> {
    const body: Record<string, unknown> = {
      product_id: this.productId(req.instrumentKey),
      size: req.qty,
      side: req.side.toLowerCase(),
      client_order_id: req.clientOrderId.slice(0, 32),
      reduce_only: !!req.reduceOnly,
      time_in_force: req.validity === 'IOC' ? 'ioc' : 'gtc',
    };
    if (req.type === 'LIMIT') {
      body.order_type = 'limit_order';
      body.limit_price = String(req.price);
    } else if (req.type === 'SL' || req.type === 'SL-M') {
      body.order_type = req.type === 'SL' ? 'limit_order' : 'market_order';
      if (req.type === 'SL') body.limit_price = String(req.price);
      body.stop_order_type = 'stop_loss_order';
      body.stop_price = String(req.triggerPrice);
    } else {
      body.order_type = 'market_order';
    }
    const r = await this.call<{ id: number }>('POST', '/v2/orders', {}, body);
    return { brokerOrderId: String(r.id) };
  }

  async modifyOrder(brokerOrderId: string, patch: { qty?: number; price?: number; triggerPrice?: number }): Promise<void> {
    const o = (await this.getOrders()).find((x) => x.brokerOrderId === brokerOrderId);
    if (!o) throw new BrokerError('order not found', 'NOT_FOUND', false);
    await this.call('PUT', '/v2/orders', {}, {
      id: Number(brokerOrderId), product_id: this.productId(o.instrumentKey),
      ...(patch.qty ? { size: patch.qty } : {}), ...(patch.price ? { limit_price: String(patch.price) } : {}), ...(patch.triggerPrice ? { stop_price: String(patch.triggerPrice) } : {}),
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const o = (await this.getOrders()).find((x) => x.brokerOrderId === brokerOrderId);
    if (!o) return;
    await this.call('DELETE', '/v2/orders', {}, { id: Number(brokerOrderId), product_id: this.productId(o.instrumentKey) });
  }

  async getOrders(): Promise<BrokerOrderState[]> {
    const rows = await this.call<Record<string, any>[]>('GET', '/v2/orders', { states: 'open,pending' });
    const bySym = new Map([...this.productIds].map(([s, id]) => [id, s]));
    return rows.map((r) => {
      const size = Number(r.size);
      const unfilled = Number(r.unfilled_size ?? size);
      const filled = size - unfilled;
      return {
        brokerOrderId: String(r.id),
        clientOrderId: r.client_order_id ?? undefined,
        instrumentKey: bySym.get(r.product_id) ?? r.product_symbol ?? String(r.product_id),
        side: String(r.side).toUpperCase() as Side,
        qty: size,
        filledQty: filled,
        avgPrice: Number(r.average_fill_price ?? 0),
        status: r.state === 'open' ? (filled > 0 ? 'PARTIALLY_FILLED' : 'NEW') : r.state === 'pending' ? 'NEW' : r.state === 'closed' ? 'FILLED' : 'CANCELLED',
        type: r.order_type === 'limit_order' ? 'LIMIT' : 'MARKET',
        price: r.limit_price ? Number(r.limit_price) : undefined,
        triggerPrice: r.stop_price ? Number(r.stop_price) : undefined,
        ts: r.created_at ? Date.parse(r.created_at) : Date.now(),
      };
    });
  }

  async getPositions(): Promise<BrokerPositionState[]> {
    const rows = await this.call<Record<string, any>[]>('GET', '/v2/positions/margined');
    return rows.filter((r) => Number(r.size) !== 0).map((r) => ({ instrumentKey: r.product_symbol, qty: Number(r.size), avgPrice: Number(r.entry_price) }));
  }

  onOrderUpdate(cb: (u: BrokerOrderState) => void): void {
    this.updateCbs.push(cb);
  }

  onFill(cb: Parameters<Broker['onFill']>[0]): void {
    this.fillCbs.push(cb);
  }

  /** Refresh the venue-side cancel-after (dead-man) timer. */
  async heartbeat(): Promise<void> {
    if (!this.configured()) return;
    try {
      await this.call('POST', '/v2/orders/cancel_after', {}, { cancel_after: this.deadmanMs });
    } catch (e) {
      log.error('dead-man heartbeat failed', { err: String(e) });
      throw e;
    }
  }
}
