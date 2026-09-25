// In-process event bus with Redis-Streams-like semantics that matter here:
// - every topic keeps a bounded, ordered log with monotonically increasing ids
// - handlers are isolated: one throwing handler never affects others or the publisher
// - async handlers run detached so slow consumers (LLM research) never block the
//   1-minute decision loop (plan §C "Never block the 1-minute loop on an LLM").
// The interface is intentionally small so a Redis Streams adapter can replace it
// when the system is split across processes.

import type { Anomaly, Bar, Fill, ResearchVerdict, Signal, Tick } from './types.ts';
import { createLogger } from './logger.ts';

const log = createLogger('events');

export interface EventMap {
  tick: Tick;
  bar: Bar;
  anomaly: Anomaly;
  'research.request': { anomaly?: Anomaly; key: string; symbol: string; reason: 'anomaly' | 'position' | 'filing' | 'manual'; deep?: boolean };
  'research.verdict': ResearchVerdict;
  signal: Signal & { decision: 'accepted' | 'rejected' | 'shadow'; rejectReasons?: string[] };
  'order.update': { clientOrderId: string; status: string; brokerOrderId?: string; reason?: string; strategyId: string; instrumentKey: string };
  fill: Fill;
  'risk.event': { kind: string; severity: 'info' | 'warn' | 'critical'; message: string; data?: Record<string, unknown> };
  alert: { severity: 'P0' | 'P1' | 'P2' | 'INFO'; title: string; message: string; ts: number };
  'killswitch': { engaged: boolean; reason: string; by: string; ts: number };
  'position.update': { instrumentKey: string; qty: number; avgPrice: number; strategyId: string };
  'system': { kind: string; message: string; data?: Record<string, unknown> };
}

export type Topic = keyof EventMap;
export interface Envelope<T extends Topic = Topic> {
  id: number;
  topic: T;
  ts: number;
  data: EventMap[T];
}
type Handler<T extends Topic> = (data: EventMap[T], env: Envelope<T>) => void | Promise<void>;

// Only low-frequency topics are retained for replay to the admin UI.
const RETAIN: Partial<Record<Topic, number>> = {
  anomaly: 2000,
  'research.verdict': 500,
  signal: 1000,
  'order.update': 2000,
  fill: 2000,
  'risk.event': 1000,
  alert: 500,
  killswitch: 100,
  system: 500,
};

export class EventBus {
  private handlers = new Map<Topic, Set<Handler<any>>>();
  private wildcard = new Set<(env: Envelope) => void>();
  private logs = new Map<Topic, Envelope[]>();
  private seq = 0;
  private counts = new Map<Topic, number>();
  private handlerErrors = 0;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  on<T extends Topic>(topic: T, h: Handler<T>): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(h as Handler<any>);
    return () => set!.delete(h as Handler<any>);
  }

  /** Receive every retained-topic envelope (used by the SSE stream). */
  onAny(h: (env: Envelope) => void): () => void {
    this.wildcard.add(h);
    return () => this.wildcard.delete(h);
  }

  publish<T extends Topic>(topic: T, data: EventMap[T]): Envelope<T> {
    const env: Envelope<T> = { id: ++this.seq, topic, ts: this.now(), data };
    this.counts.set(topic, (this.counts.get(topic) ?? 0) + 1);
    const cap = RETAIN[topic];
    if (cap) {
      let l = this.logs.get(topic);
      if (!l) this.logs.set(topic, (l = []));
      l.push(env as Envelope);
      if (l.length > cap) l.splice(0, l.length - cap);
      for (const w of this.wildcard) {
        try {
          w(env as Envelope);
        } catch (e) {
          this.handlerErrors++;
          log.error('wildcard handler failed', { topic, err: String(e) });
        }
      }
    }
    const set = this.handlers.get(topic);
    if (set) {
      for (const h of set) {
        try {
          const r = h(data, env);
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch((e) => {
              this.handlerErrors++;
              log.error('async handler failed', { topic, err: String(e?.stack ?? e) });
            });
          }
        } catch (e) {
          this.handlerErrors++;
          log.error('handler failed', { topic, err: String((e as Error)?.stack ?? e) });
        }
      }
    }
    return env;
  }

  history<T extends Topic>(topic: T, limit = 200): Envelope<T>[] {
    const l = (this.logs.get(topic) ?? []) as Envelope<T>[];
    return l.slice(-limit).reverse();
  }

  stats(): { counts: Record<string, number>; handlerErrors: number; seq: number } {
    return { counts: Object.fromEntries(this.counts), handlerErrors: this.handlerErrors, seq: this.seq };
  }
}
