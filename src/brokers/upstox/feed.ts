// Upstox Market Data Feed V3 (protobuf over WebSocket) with tiered subscriptions.
// Caps (plan §3): 2 connections per user; LTPC 5,000 keys alone / 2,000 combined;
// Option Greeks 3,000 / 2,000; Full 2,000 / 1,500. We run both connections:
//   conn A: Full mode  — Tier A (<= 1,500, combined cap)
//   conn B: LTPC mode  — Tier B (<= 2,000, combined cap)
// First message after connecting is market status, the second a snapshot.
// LTPC carries no cumulative volume, so relative-volume outside Tier A comes from
// REST sweeps (snapshotSweeper.ts).

import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tick } from '../../core/types.ts';
import { createLogger } from '../../core/logger.ts';

const log = createLogger('upstox-feed');
const here = dirname(fileURLToPath(import.meta.url));
const root = protobuf.loadSync(join(here, 'MarketDataFeedV3.proto'));
const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');

export const TIER_CAPS = { A_FULL: 1500, B_LTPC: 2000 } as const;

export interface DecodedFeed {
  type: string;
  currentTs?: number;
  ticks: Tick[];
  marketInfo?: { segmentStatus?: Record<string, string>; casMarketStatus?: Record<string, { status: string; updatedTime?: number }>; preOpenSessionStatus?: Record<string, { status: string; updatedTime?: number }> };
}

type Obj = Record<string, any>;

export function decodeFeed(buf: Uint8Array, recvTs = Date.now()): DecodedFeed {
  const m = FeedResponse.toObject(FeedResponse.decode(buf), { longs: Number, enums: String, defaults: false, oneofs: true }) as Obj;
  const ticks: Tick[] = [];
  for (const [key, f] of Object.entries((m.feeds ?? {}) as Record<string, Obj>)) {
    if (f.ltpc) {
      ticks.push({ key, ltp: f.ltpc.ltp, ltt: f.ltpc.ltt ?? 0, ltq: f.ltpc.ltq, cp: f.ltpc.cp, iep: f.ltpc.iep?.value, recvTs, source: 'ws_ltpc' });
    } else if (f.fullFeed?.marketFF) {
      const ff = f.fullFeed.marketFF as Obj;
      const depth = (ff.marketLevel?.bidAskQuote ?? []) as { bidQ?: number; bidP?: number; askQ?: number; askP?: number }[];
      ticks.push({
        key,
        ltp: ff.ltpc?.ltp ?? 0,
        ltt: ff.ltpc?.ltt ?? 0,
        ltq: ff.ltpc?.ltq,
        cp: ff.ltpc?.cp,
        vtt: ff.vtt,
        oi: ff.oi,
        iv: ff.iv,
        atp: ff.atp,
        tbq: ff.tbq,
        tsq: ff.tsq,
        iep: ff.iep,
        bid: depth[0]?.bidP,
        ask: depth[0]?.askP,
        bidQty: depth[0]?.bidQ,
        askQty: depth[0]?.askQ,
        depth: depth.map((d) => ({ bidQ: d.bidQ ?? 0, bidP: d.bidP ?? 0, askQ: d.askQ ?? 0, askP: d.askP ?? 0 })),
        recvTs,
        source: 'ws_full',
      });
    } else if (f.fullFeed?.indexFF) {
      const ix = f.fullFeed.indexFF as Obj;
      ticks.push({ key, ltp: ix.ltpc?.ltp ?? 0, ltt: ix.ltpc?.ltt ?? 0, cp: ix.ltpc?.cp, recvTs, source: 'ws_full' });
    } else if (f.firstLevelWithGreeks) {
      const g = f.firstLevelWithGreeks as Obj;
      ticks.push({ key, ltp: g.ltpc?.ltp ?? 0, ltt: g.ltpc?.ltt ?? 0, ltq: g.ltpc?.ltq, cp: g.ltpc?.cp, vtt: g.vtt, oi: g.oi, iv: g.iv, bid: g.firstDepth?.bidP, ask: g.firstDepth?.askP, recvTs, source: 'ws_full' });
    }
  }
  return { type: m.type ?? 'live_feed', currentTs: m.currentTs, ticks: ticks.filter((t) => t.ltp > 0), marketInfo: m.marketInfo };
}

/** Test helper: encode a FeedResponse object. */
export function encodeFeed(obj: Obj): Uint8Array {
  return FeedResponse.encode(FeedResponse.fromObject(obj)).finish();
}

type Mode = 'full' | 'ltpc';

class FeedConnection {
  readonly name: string;
  readonly mode: Mode;
  readonly cap: number;
  keys = new Set<string>();
  ws?: WebSocket;
  connected = false;
  reconnects = 0;
  lastMsgAt = 0;
  private backoff = 1000;
  private closing = false;
  private authorize: () => Promise<string>;
  private onMsg: (d: DecodedFeed) => void;
  private onReconnected: (name: string, downSince: number) => void;
  private downSince = 0;

  constructor(name: string, mode: Mode, cap: number, authorize: () => Promise<string>, onMsg: (d: DecodedFeed) => void, onReconnected: (name: string, downSince: number) => void) {
    this.name = name;
    this.mode = mode;
    this.cap = cap;
    this.authorize = authorize;
    this.onMsg = onMsg;
    this.onReconnected = onReconnected;
  }

  async connect(): Promise<void> {
    this.closing = false;
    let uri: string;
    try {
      uri = await this.authorize();
    } catch (e) {
      log.error('feed authorize failed', { conn: this.name, err: String(e) });
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(uri);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      const wasDown = this.downSince;
      this.connected = true;
      this.backoff = 1000;
      log.info('feed connected', { conn: this.name, keys: this.keys.size });
      this.send('sub', [...this.keys]);
      if (wasDown) this.onReconnected(this.name, wasDown);
      this.downSince = 0;
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      try {
        this.onMsg(decodeFeed(new Uint8Array(ev.data as ArrayBuffer)));
      } catch (e) {
        log.warn('feed decode failed', { conn: this.name, err: String(e) });
      }
    };
    ws.onclose = () => {
      this.connected = false;
      if (!this.downSince) this.downSince = Date.now();
      if (!this.closing) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    this.reconnects++;
    if (!this.downSince) this.downSince = Date.now();
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    setTimeout(() => void this.connect(), wait).unref?.();
  }

  send(method: 'sub' | 'unsub' | 'change_mode', keys: string[]): void {
    if (!this.ws || !this.connected || !keys.length) return;
    for (let i = 0; i < keys.length; i += 500) {
      const payload = { guid: randomUUID(), method, data: { mode: this.mode, instrumentKeys: keys.slice(i, i + 500) } };
      // Upstox expects the JSON request as a binary frame.
      this.ws.send(new TextEncoder().encode(JSON.stringify(payload)));
    }
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
  }
}

export interface FeedStatus {
  connections: { name: string; mode: Mode; connected: boolean; keys: number; cap: number; reconnects: number; lastMsgAt: number }[];
  marketStatus: Record<string, string>;
  lastCurrentTs?: number;
}

export class UpstoxFeed {
  private a: FeedConnection;
  private b: FeedConnection;
  private marketStatus: Record<string, string> = {};
  private lastCurrentTs?: number;

  constructor(authorize: () => Promise<string>, onTick: (t: Tick) => void, onReconnected: (conn: string, downSince: number, keys: string[]) => void) {
    const handle = (d: DecodedFeed) => {
      if (d.currentTs) this.lastCurrentTs = d.currentTs;
      if (d.marketInfo?.segmentStatus) Object.assign(this.marketStatus, d.marketInfo.segmentStatus);
      for (const t of d.ticks) onTick(t);
    };
    this.a = new FeedConnection('A-full', 'full', TIER_CAPS.A_FULL, authorize, handle, (n, s) => onReconnected(n, s, [...this.a.keys]));
    this.b = new FeedConnection('B-ltpc', 'ltpc', TIER_CAPS.B_LTPC, authorize, handle, (n, s) => onReconnected(n, s, [...this.b.keys]));
  }

  private conn(tier: 'A' | 'B'): FeedConnection {
    return tier === 'A' ? this.a : this.b;
  }

  /** Replace a tier's subscription set; excess keys beyond the cap are dropped (logged). */
  setTier(tier: 'A' | 'B', keys: string[]): string[] {
    const c = this.conn(tier);
    const wanted = keys.slice(0, c.cap);
    if (keys.length > c.cap) log.warn('tier over cap; truncating', { tier, requested: keys.length, cap: c.cap });
    const next = new Set(wanted);
    const add = wanted.filter((k) => !c.keys.has(k));
    const remove = [...c.keys].filter((k) => !next.has(k));
    c.keys = next;
    c.send('unsub', remove);
    c.send('sub', add);
    return keys.slice(c.cap);
  }

  /** Move a key from Tier B/C into Tier A, evicting `evict` from A (see scanner/promotion.ts). */
  promote(key: string, evict?: string): void {
    if (evict && this.a.keys.delete(evict)) {
      this.a.send('unsub', [evict]);
    }
    if (this.a.keys.size >= this.a.cap) throw new Error('Tier A full; promotion requires an eviction');
    if (this.b.keys.delete(key)) this.b.send('unsub', [key]);
    this.a.keys.add(key);
    this.a.send('sub', [key]);
    if (evict && this.b.keys.size < this.b.cap) {
      this.b.keys.add(evict);
      this.b.send('sub', [evict]);
    }
  }

  tierOf(key: string): 'A' | 'B' | undefined {
    return this.a.keys.has(key) ? 'A' : this.b.keys.has(key) ? 'B' : undefined;
  }

  tierKeys(tier: 'A' | 'B'): string[] {
    return [...this.conn(tier).keys];
  }

  async start(): Promise<void> {
    await Promise.all([this.a.connect(), this.b.connect()]);
  }

  stop(): void {
    this.a.close();
    this.b.close();
  }

  status(): FeedStatus {
    return {
      connections: [this.a, this.b].map((c) => ({ name: c.name, mode: c.mode, connected: c.connected, keys: c.keys.size, cap: c.cap, reconnects: c.reconnects, lastMsgAt: c.lastMsgAt })),
      marketStatus: this.marketStatus,
      lastCurrentTs: this.lastCurrentTs,
    };
  }
}
