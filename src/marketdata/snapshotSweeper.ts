// Tier C coverage: REST full-quote sweeps at 500 keys/call (plan §B).
// ~5,000 symbols = ~10 calls per sweep, which fits inside 250 calls/min even at a
// 15-second cadence. Each quote also carries the day's circuit limits, used to
// keep bands current, and cumulative volume for RVOL outside Tier A.

import type { Tick } from '../core/types.ts';
import type { UpstoxClient, UpstoxQuote } from '../brokers/upstox/rest.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('sweeper');

export function quoteToTick(q: UpstoxQuote, recvTs: number): Tick | undefined {
  if (!q?.instrument_token || !(q.last_price > 0)) return undefined;
  const b = q.depth?.buy?.[0];
  const s = q.depth?.sell?.[0];
  const ltt = q.last_trade_time ? Number(q.last_trade_time) : Date.parse(q.timestamp ?? '') || recvTs;
  return {
    key: q.instrument_token,
    ltp: q.last_price,
    ltt: Number.isFinite(ltt) ? ltt : recvTs,
    recvTs,
    vtt: q.volume,
    oi: q.oi,
    atp: q.average_price,
    tbq: q.total_buy_quantity,
    tsq: q.total_sell_quantity,
    cp: q.ohlc?.close && q.net_change !== undefined ? q.last_price - q.net_change : undefined,
    bid: b?.price || undefined,
    ask: s?.price || undefined,
    bidQty: b?.quantity,
    askQty: s?.quantity,
    source: 'rest',
  };
}

export class SnapshotSweeper {
  private client: UpstoxClient;
  private keys: string[] = [];
  private timer?: NodeJS.Timeout;
  private onTick: (t: Tick) => void;
  private onBand: (key: string, lower: number, upper: number) => void;
  intervalMs: number;
  sweeps = 0;
  errors = 0;
  lastSweepMs = 0;
  private running = false;

  constructor(client: UpstoxClient, onTick: (t: Tick) => void, onBand: (key: string, lower: number, upper: number) => void, intervalMs = 30_000) {
    this.client = client;
    this.onTick = onTick;
    this.onBand = onBand;
    this.intervalMs = intervalMs;
  }

  setKeys(keys: string[]): void {
    this.keys = [...new Set(keys)];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<number> {
    if (this.running || !this.keys.length || !this.client.hasToken()) return 0;
    this.running = true;
    const t0 = Date.now();
    let n = 0;
    try {
      const qs = await this.client.quotes(this.keys);
      const now = Date.now();
      for (const q of qs) {
        const t = quoteToTick(q, now);
        if (!t) continue;
        n++;
        this.onTick(t);
        if (q.lower_circuit_limit && q.upper_circuit_limit) this.onBand(t.key, q.lower_circuit_limit, q.upper_circuit_limit);
      }
      this.sweeps++;
    } catch (e) {
      this.errors++;
      log.warn('sweep failed', { err: String(e) });
    } finally {
      this.lastSweepMs = Date.now() - t0;
      this.running = false;
    }
    return n;
  }
}
