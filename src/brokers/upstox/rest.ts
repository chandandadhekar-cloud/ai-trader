// Upstox REST client (orders, portfolio, quotes, history, auth).
// Order endpoints go through: compliance (static IP + X-Algo-Name) → OPS throttle
// → API rate limiter. Data endpoints only go through the API rate limiter.
// Upstox reportedly stopped API market orders from 1 Oct 2025 (unverified), so the
// OMS always sends LIMIT orders with price protection.

import type { OrderRequest, Side } from '../../core/types.ts';
import type { Settings } from '../../config/settings.ts';
import { createLogger } from '../../core/logger.ts';
import { BrokerError, type Broker, type BrokerOrderState, type BrokerPositionState } from '../broker.ts';
import type { ComplianceGuard } from '../compliance.ts';
import { OrderThrottle, SlidingWindowLimiter } from '../throttle.ts';

const log = createLogger('upstox');

export const UPSTOX_API = 'https://api.upstox.com';
export const UPSTOX_HFT = 'https://api-hft.upstox.com';
export const UPSTOX_SANDBOX = 'https://api-sandbox.upstox.com';

export interface UpstoxQuote {
  instrument_token: string;
  symbol?: string;
  last_price: number;
  volume?: number;
  average_price?: number;
  oi?: number;
  net_change?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  lower_circuit_limit?: number;
  upper_circuit_limit?: number;
  last_trade_time?: string;
  timestamp?: string;
  ohlc?: { open: number; high: number; low: number; close: number };
  depth?: { buy: { quantity: number; price: number; orders: number }[]; sell: { quantity: number; price: number; orders: number }[] };
}

const STATUS_MAP: Record<string, BrokerOrderState['status']> = {
  'put order req received': 'PENDING_NEW',
  'validation pending': 'PENDING_NEW',
  'open pending': 'PENDING_NEW',
  'trigger pending': 'NEW',
  open: 'NEW',
  'after market order req received': 'NEW',
  'modify pending': 'NEW',
  'modify validation pending': 'NEW',
  'modified': 'NEW',
  'cancel pending': 'PENDING_CANCEL',
  cancelled: 'CANCELLED',
  'cancelled after market order': 'CANCELLED',
  rejected: 'REJECTED',
  complete: 'FILLED',
};

export function mapUpstoxStatus(s: string, filled: number, qty: number): BrokerOrderState['status'] {
  const m = STATUS_MAP[s.toLowerCase()] ?? 'NEW';
  if (m === 'NEW' && filled > 0 && filled < qty) return 'PARTIALLY_FILLED';
  return m;
}

export class UpstoxClient implements Broker {
  readonly name = 'upstox';
  readonly live: boolean;
  private s: Settings;
  private token?: string;
  private compliance: ComplianceGuard;
  readonly throttle: OrderThrottle;
  readonly apiLimiter: SlidingWindowLimiter;
  private updateCbs: ((u: BrokerOrderState) => void)[] = [];
  private fillCbs: Parameters<Broker['onFill']>[0][] = [];
  private lastHeaders?: Record<string, string>;
  private fetchImpl: typeof fetch;

  constructor(s: Settings, compliance: ComplianceGuard, throttle: OrderThrottle, fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.token = s.UPSTOX_ACCESS_TOKEN;
    this.compliance = compliance;
    this.throttle = throttle;
    this.live = s.MODE === 'live' && !s.UPSTOX_SANDBOX;
    this.fetchImpl = fetchImpl;
    this.apiLimiter = new SlidingWindowLimiter([
      { ms: 1000, max: s.UPSTOX_REQ_PER_SEC },
      { ms: 60_000, max: s.UPSTOX_REQ_PER_MIN },
      { ms: 30 * 60_000, max: s.UPSTOX_REQ_PER_30MIN },
    ]);
  }

  hasToken(): boolean {
    return !!this.token;
  }

  setToken(t: string | undefined): void {
    this.token = t;
  }

  lastOrderHeaders(): Record<string, string> | undefined {
    return this.lastHeaders;
  }

  // ---- auth ---------------------------------------------------------------

  loginUrl(state = 'tradeai'): string {
    const p = new URLSearchParams({ response_type: 'code', client_id: this.s.UPSTOX_API_KEY ?? '', redirect_uri: this.s.UPSTOX_REDIRECT_URI ?? '', state });
    return `${UPSTOX_API}/v2/login/authorization/dialog?${p}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      code, client_id: this.s.UPSTOX_API_KEY ?? '', client_secret: this.s.UPSTOX_API_SECRET ?? '',
      redirect_uri: this.s.UPSTOX_REDIRECT_URI ?? '', grant_type: 'authorization_code',
    });
    const res = await this.fetchImpl(`${UPSTOX_API}/v2/login/authorization/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { access_token?: string; errors?: unknown };
    if (!res.ok || !j.access_token) throw new BrokerError(`token exchange failed: ${JSON.stringify(j.errors ?? j)}`, 'AUTH', false, res.status);
    this.token = j.access_token;
    return j.access_token;
  }

  /** Session logout (required before the next trading day). */
  async logout(): Promise<void> {
    if (!this.token) return;
    await this.request('DELETE', UPSTOX_API, '/v2/logout');
    this.token = undefined;
  }

  // ---- low-level ------------------------------------------------------------

  private async request<T>(method: string, base: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.token) throw new BrokerError('no Upstox access token', 'AUTH', false);
    await this.apiLimiter.acquire(5_000);
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}`, ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new BrokerError(`network error ${method} ${path}: ${String((e as Error).message ?? e)}`, 'NETWORK', true);
    }
    const text = await res.text();
    let j: { status?: string; data?: T; errors?: { errorCode?: string; message?: string }[] } = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page */
    }
    log.debug('upstox call', { method, path, status: res.status, ms: Date.now() - t0 });
    if (!res.ok || j.status === 'error') {
      const err = j.errors?.[0];
      if (res.status === 401) this.token = undefined;
      throw new BrokerError(`${method} ${path} → ${res.status} ${err?.errorCode ?? ''} ${err?.message ?? text.slice(0, 200)}`.trim(), err?.errorCode ?? `HTTP_${res.status}`, res.status === 429 || res.status >= 500, res.status);
    }
    return j.data as T;
  }

  private orderBase(): string {
    return this.s.UPSTOX_SANDBOX ? UPSTOX_SANDBOX : UPSTOX_HFT;
  }

  /** All order-API calls: compliance gate, OPS throttle, X-Algo-Name header. */
  private async orderCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.live) this.compliance.assertLiveOrderAllowed();
    const h = this.compliance.orderHeaders();
    this.lastHeaders = h;
    await this.throttle.acquire();
    return this.request<T>(method, this.orderBase(), path, body, h);
  }

  // ---- orders --------------------------------------------------------------

  async placeOrder(req: OrderRequest): Promise<{ brokerOrderId: string }> {
    if (req.type === 'MARKET' || req.type === 'SL-M') {
      throw new BrokerError('market / SL-M orders are not sent via API; use LIMIT/SL with price protection', 'ORDER_TYPE', false);
    }
    const body = {
      quantity: req.qty,
      product: req.product,
      validity: req.validity,
      price: req.price ?? 0,
      tag: (req.tag ?? req.clientOrderId).slice(0, 20), // client order ids are 20 chars
      instrument_token: req.instrumentKey,
      order_type: req.type,
      transaction_type: req.side,
      disclosed_quantity: 0,
      trigger_price: req.triggerPrice ?? 0,
      is_amo: false,
      slice: true,
    };
    const d = await this.orderCall<{ order_ids: string[] }>('POST', '/v3/order/place', body);
    const id = d?.order_ids?.[0];
    if (!id) throw new BrokerError('place order: no order id returned', 'NO_ID', false);
    return { brokerOrderId: id };
  }

  async modifyOrder(brokerOrderId: string, patch: { qty?: number; price?: number; triggerPrice?: number }): Promise<void> {
    const cur = (await this.getOrders()).find((o) => o.brokerOrderId === brokerOrderId);
    if (!cur) throw new BrokerError(`modify: order ${brokerOrderId} not found`, 'NOT_FOUND', false);
    await this.orderCall('PUT', '/v3/order/modify', {
      order_id: brokerOrderId,
      quantity: patch.qty ?? cur.qty,
      validity: 'DAY',
      price: patch.price ?? cur.price ?? 0,
      order_type: cur.type,
      disclosed_quantity: 0,
      trigger_price: patch.triggerPrice ?? cur.triggerPrice ?? 0,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.orderCall('DELETE', `/v3/order/cancel?order_id=${encodeURIComponent(brokerOrderId)}`);
  }

  /**
   * Single-leg GTT stop for overnight (delivery) protection. Intraday protection
   * uses exchange-resident SL orders instead. Targets are managed by the system.
   * For a long position: SELL, triggers BELOW the stop; for a short: BUY, ABOVE.
   */
  async placeGttStop(p: { instrumentKey: string; side: Side; qty: number; product: string; stopTrigger: number }): Promise<string> {
    const d = await this.orderCall<{ gtt_order_ids: string[] }>('POST', '/v3/order/gtt/place', {
      type: 'SINGLE',
      quantity: p.qty,
      product: p.product,
      instrument_token: p.instrumentKey,
      transaction_type: p.side,
      rules: [{ strategy: 'ENTRY', trigger_type: p.side === 'SELL' ? 'BELOW' : 'ABOVE', trigger_price: p.stopTrigger }],
    });
    const id = d?.gtt_order_ids?.[0];
    if (!id) throw new BrokerError('GTT place: no id', 'NO_ID', false);
    return id;
  }

  async cancelGtt(id: string): Promise<void> {
    await this.orderCall('DELETE', '/v3/order/gtt/cancel', { gtt_order_id: id });
  }

  async exitAll(): Promise<void> {
    await this.orderCall('POST', '/v2/order/positions/exit', {});
  }

  async getOrders(): Promise<BrokerOrderState[]> {
    const rows = await this.request<Record<string, unknown>[]>('GET', UPSTOX_API, '/v2/order/retrieve-all');
    return (rows ?? []).map((r) => {
      const qty = Number(r.quantity ?? 0);
      const filled = Number(r.filled_quantity ?? 0);
      return {
        brokerOrderId: String(r.order_id),
        clientOrderId: r.tag ? String(r.tag) : undefined,
        instrumentKey: String(r.instrument_token ?? ''),
        side: String(r.transaction_type) as Side,
        qty,
        filledQty: filled,
        avgPrice: Number(r.average_price ?? 0),
        status: mapUpstoxStatus(String(r.status ?? ''), filled, qty),
        type: String(r.order_type) as OrderRequest['type'],
        price: Number(r.price ?? 0) || undefined,
        triggerPrice: Number(r.trigger_price ?? 0) || undefined,
        reason: r.status_message ? String(r.status_message) : undefined,
        tag: r.tag ? String(r.tag) : undefined,
        ts: Date.parse(String(r.order_timestamp ?? '')) || Date.now(),
      };
    });
  }

  async getPositions(): Promise<BrokerPositionState[]> {
    const rows = await this.request<Record<string, unknown>[]>('GET', UPSTOX_API, '/v2/portfolio/short-term-positions');
    return (rows ?? [])
      .map((r) => ({
        instrumentKey: String(r.instrument_token ?? ''),
        qty: Number(r.quantity ?? 0),
        avgPrice: Number(r.average_price ?? r.buy_price ?? 0),
        product: r.product ? String(r.product) : undefined,
      }))
      .filter((p) => p.qty !== 0);
  }

  onOrderUpdate(cb: (u: BrokerOrderState) => void): void {
    this.updateCbs.push(cb);
  }

  onFill(cb: Parameters<Broker['onFill']>[0]): void {
    this.fillCbs.push(cb);
  }

  /** Called by the portfolio-stream consumer or the order poller. */
  emitUpdate(u: BrokerOrderState, fillDelta?: { qty: number; price: number }): void {
    for (const cb of this.updateCbs) cb(u);
    if (fillDelta && fillDelta.qty > 0 && u.clientOrderId) {
      for (const cb of this.fillCbs) {
        cb({ clientOrderId: u.clientOrderId, brokerOrderId: u.brokerOrderId, instrumentKey: u.instrumentKey, side: u.side, qty: fillDelta.qty, price: fillDelta.price, ts: Date.now() });
      }
    }
  }

  // ---- order-state polling ----------------------------------------------------
  // Order updates come from polling the order book (one call every `intervalMs`,
  // well inside the rate limits). Each change is emitted as an update, and any
  // increase in filled quantity as a fill whose price is backed out of the
  // change in average price. The OMS is idempotent to repeated states.

  private known = new Map<string, { status: string; filled: number; avg: number }>();
  private pollTimer?: NodeJS.Timeout;
  pollErrors = 0;

  startOrderPoller(intervalMs = 2000): void {
    if (this.pollTimer) return;
    const tick = async () => {
      if (!this.token) return;
      try {
        await this.pollOrdersOnce();
      } catch (e) {
        this.pollErrors++;
        log.warn('order poll failed', { err: String(e) });
      }
    };
    this.pollTimer = setInterval(() => void tick(), intervalMs);
    this.pollTimer.unref?.();
  }

  stopOrderPoller(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async pollOrdersOnce(): Promise<number> {
    const orders = await this.getOrders();
    let changes = 0;
    for (const o of orders) {
      const prev = this.known.get(o.brokerOrderId) ?? { status: '', filled: 0, avg: 0 };
      if (prev.status === o.status && prev.filled === o.filledQty) continue;
      changes++;
      const dq = o.filledQty - prev.filled;
      let fill: { qty: number; price: number } | undefined;
      if (dq > 0) {
        const px = o.avgPrice > 0 ? (o.avgPrice * o.filledQty - prev.avg * prev.filled) / dq : o.price ?? 0;
        fill = { qty: dq, price: Math.round(px * 100) / 100 };
      }
      this.known.set(o.brokerOrderId, { status: o.status, filled: o.filledQty, avg: o.avgPrice });
      this.emitUpdate(o, fill);
    }
    return changes;
  }

  // ---- market data ---------------------------------------------------------

  /** Full quotes, up to 500 keys per call (plan §3). */
  async quotes(keys: string[]): Promise<UpstoxQuote[]> {
    const out: UpstoxQuote[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const d = await this.request<Record<string, UpstoxQuote>>('GET', UPSTOX_API, `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(chunk.join(','))}`);
      // Response is keyed by "EXCHANGE:SYMBOL"; instrument_token carries the key.
      for (const q of Object.values(d ?? {})) out.push(q);
    }
    return out;
  }

  /**
   * V3 historical candles. unit: minutes|hours|days|weeks|months.
   * Minutes/hours available from Jan 2022; days+ from Jan 2000.
   * Returns [ts, open, high, low, close, volume, oi] rows, newest first.
   */
  async historical(key: string, unit: string, interval: number, toDate: string, fromDate: string): Promise<[string, number, number, number, number, number, number][]> {
    const d = await this.request<{ candles: [string, number, number, number, number, number, number][] }>(
      'GET', UPSTOX_API, `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${toDate}/${fromDate}`,
    );
    return d?.candles ?? [];
  }

  async intraday(key: string, unit = 'minutes', interval = 1): Promise<[string, number, number, number, number, number, number][]> {
    const d = await this.request<{ candles: [string, number, number, number, number, number, number][] }>(
      'GET', UPSTOX_API, `/v3/historical-candle/intraday/${encodeURIComponent(key)}/${unit}/${interval}`,
    );
    return d?.candles ?? [];
  }

  async optionChain(underlyingKey: string, expiry: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', UPSTOX_API, `/v2/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiry}`);
  }

  async feedAuthorize(): Promise<string> {
    const d = await this.request<{ authorized_redirect_uri: string; authorizedRedirectUri?: string }>('GET', UPSTOX_API, '/v3/feed/market-data-feed/authorize');
    const uri = d?.authorized_redirect_uri ?? d?.authorizedRedirectUri;
    if (!uri) throw new BrokerError('feed authorize: no URI', 'FEED_AUTH', true);
    return uri;
  }

  async portfolioFeedAuthorize(): Promise<string> {
    const d = await this.request<{ authorized_redirect_uri: string }>('GET', UPSTOX_API, '/v2/feed/portfolio-stream-feed/authorize?update_types=order%2Cgtt_order%2Cposition');
    return d.authorized_redirect_uri;
  }
}
