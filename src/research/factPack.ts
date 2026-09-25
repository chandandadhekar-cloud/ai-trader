// Stage 0: deterministic fact pack (plan §C), built in < 2 s with no LLM.
// Everything the model may use is in here with a source ID; the model is told
// to use nothing else, and the verifier drops any claim citing an unknown ID.

import type { Anomaly, Instrument } from '../core/types.ts';
import type { Db } from '../db/database.ts';
import type { QuoteBook } from '../marketdata/quoteBook.ts';
import type { SurveillanceService } from '../surveillance/service.ts';
import type { InstrumentRegistry } from '../refdata/instruments.ts';
import { gatherDocs, SOURCE_RANK, type NewsSource, type SourceDoc } from './sources.ts';
import { lexiconScore } from './localNlp.ts';
import { median } from '../scanner/stats.ts';
import { newId, sha256 } from '../core/ids.ts';

export interface FactSource {
  id: string;
  kind: SourceDoc['kind'];
  rank: number;
  source: string;
  title: string;
  body?: string;
  publishedTs: number;
  receivedTs: number;
  /** Negative = published before the move began. */
  minutesRelativeToMove: number;
  lexicon: number;
}

export interface FactPack {
  id: string;
  symbol: string;
  key: string;
  builtAt: number;
  buildMs: number;
  move: {
    anomalyId?: string;
    type?: string;
    detectedTs: number;
    moveStartTs: number;
    price: number;
    retSinceStart?: number;
    z?: number;
    rvol?: number;
    residualZ?: number;
    sectorRet?: number;
    indexRet5?: number;
    explainedByIndex?: number;
    imbalance?: number;
    buildup?: string;
  };
  sources: FactSource[];
  deals: { side: string; qty: number; price: number; client: string; kind: string }[];
  surveillance: Record<string, unknown> | null;
  peers: { sector?: string; total: number; sameDirection: number; symbols: string[] };
  globalCues: Record<string, number | undefined>;
  pricedIn: { typicalImpact?: number; moveSoFar?: number; fractionOfTypical?: number; minutesSinceFirstPublication?: number };
  position?: { qty: number; avgPrice: number };
  sourceErrors: string[];
  /** Hash of the inputs that matter for caching (symbol + source ids + publish times). */
  sourceHash: string;
}

export interface FactPackDeps {
  db: Db;
  quotes: QuoteBook;
  surveillance: SurveillanceService;
  refdata: InstrumentRegistry;
  sources: NewsSource[];
  positionOf: (key: string) => { qty: number; avgPrice: number } | undefined;
  globalCueKeys: Record<string, string>;
  now: () => number;
}

export async function buildFactPack(deps: FactPackDeps, target: { key: string; symbol: string; anomaly?: Anomaly }, deadlineMs = 1500): Promise<FactPack> {
  const t0 = Date.now();
  const now = deps.now();
  const a = target.anomaly;
  const inst: Instrument | undefined = deps.refdata.byKey(target.key);
  const detectedTs = a?.ts ?? now;
  // The move is taken to start ~5 minutes before detection (the widest detector window).
  const moveStartTs = detectedTs - 5 * 60_000;
  const since = now - 60 * 60_000;

  const { docs, errors } = await gatherDocs(deps.sources, target.symbol, since - 24 * 3600_000, deadlineMs, inst?.name);
  const sources: FactSource[] = docs
    .filter((d) => d.receivedTs <= now + 1000)
    .slice(0, 25)
    .map((d) => ({
      id: d.id, kind: d.kind, rank: SOURCE_RANK[d.kind], source: d.source, title: d.title.slice(0, 300), body: d.body?.slice(0, 1200),
      publishedTs: d.publishedTs, receivedTs: d.receivedTs,
      minutesRelativeToMove: Math.round(((d.publishedTs - moveStartTs) / 60_000) * 10) / 10,
      lexicon: lexiconScore(`${d.title} ${d.body ?? ''}`).score,
    }));

  const flags = deps.surveillance.get(target.symbol);
  const deals = deps.surveillance.recentDeals(target.symbol).slice(0, 10).map((d) => ({ side: d.side, qty: d.qty, price: d.price, client: d.client, kind: d.kind }));

  // Peers: same-sector names moving in the same direction over the last 5 minutes.
  const moveSign = Math.sign(a?.ret ?? 0);
  const peers = { sector: inst?.sector, total: 0, sameDirection: 0, symbols: [] as string[] };
  if (inst?.sector) {
    for (const p of deps.refdata.all()) {
      if (p.key === inst.key || p.sector !== inst.sector || p.type !== 'EQ') continue;
      const bars = deps.quotes.bars(p.key, 6);
      if (bars.length < 6) continue;
      peers.total++;
      const r = Math.log(bars[5].close / bars[0].close);
      const sig = (deps.quotes.get(p.key)?.sigma1m ?? 0.002) * Math.sqrt(5);
      if (moveSign !== 0 && Math.sign(r) === moveSign && Math.abs(r) > sig) {
        peers.sameDirection++;
        peers.symbols.push(p.symbol);
      }
    }
  }

  const globalCues: Record<string, number | undefined> = {};
  for (const [name, key] of Object.entries(deps.globalCueKeys)) {
    const q = deps.quotes.get(key);
    globalCues[name] = q?.last && q.prevClose ? Math.round((q.last.ltp / q.prevClose - 1) * 1e4) / 100 : undefined;
  }

  // Priced-in: move already made vs historical total impact of this anomaly type.
  let typicalImpact: number | undefined;
  if (a) {
    const hist = deps.db.all<{ details: string; fwd_ret_30m: number }>(
      'SELECT details, fwd_ret_30m FROM anomalies WHERE type = ? AND fwd_ret_30m IS NOT NULL AND suppressed = 0 ORDER BY ts DESC LIMIT 500', a.type,
    );
    const impacts = hist
      .map((h) => {
        const ret = Number(JSON.parse(h.details).ret ?? 0);
        return Math.abs(ret) + Math.sign(ret) * h.fwd_ret_30m;
      })
      .filter((x) => Number.isFinite(x) && x > 0);
    if (impacts.length >= 20) typicalImpact = median(impacts);
  }
  const moveSoFar = a?.ret !== undefined ? Math.abs(a.ret) : undefined;
  const primary = sources.filter((s) => s.rank <= 3).sort((x, y) => x.publishedTs - y.publishedTs)[0];

  const d = a?.details ?? {};
  const pack: FactPack = {
    id: newId('FP'),
    symbol: target.symbol,
    key: target.key,
    builtAt: now,
    buildMs: 0,
    move: {
      anomalyId: a?.id, type: a?.type, detectedTs, moveStartTs, price: a?.price ?? deps.quotes.ltp(target.key) ?? 0,
      retSinceStart: a?.ret, z: a?.z, rvol: a?.rvol, residualZ: a?.residualZ,
      sectorRet: num(d.sectorRet), indexRet5: num(d.indexRet5), explainedByIndex: num(d.explainedByIndex), imbalance: num(d.imbalance),
      buildup: typeof d.buildup === 'string' ? d.buildup : undefined,
    },
    sources,
    deals,
    surveillance: flags ? { gsm: flags.gsm, ltAsm: flags.ltAsm, stAsm: flags.stAsm, esm: flags.esm, ibc: flags.ibc, inFnoBan: flags.inFnoBan, bandPct: flags.bandPct, series: flags.series } : null,
    peers,
    globalCues,
    pricedIn: {
      typicalImpact,
      moveSoFar,
      fractionOfTypical: typicalImpact && moveSoFar !== undefined ? moveSoFar / typicalImpact : undefined,
      minutesSinceFirstPublication: primary ? Math.round((now - primary.publishedTs) / 6000) / 10 : undefined,
    },
    position: deps.positionOf(target.key),
    sourceErrors: errors,
    sourceHash: sha256(`${target.symbol}|${sources.map((s) => `${s.id}@${s.publishedTs}`).sort().join(',')}|${a?.type ?? ''}`),
  };
  pack.buildMs = Date.now() - t0;
  return pack;
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** Compact JSON view sent to the model (IST times, no internal fields). */
export function factPackForPrompt(p: FactPack): string {
  const ist = (ts: number) => new Date(ts + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
  return JSON.stringify(
    {
      symbol: p.symbol,
      move: { ...p.move, detected: ist(p.move.detectedTs), move_started_approx: ist(p.move.moveStartTs), detectedTs: undefined, moveStartTs: undefined },
      sources: p.sources.map((s) => ({ id: s.id, kind: s.kind, source: s.source, published: ist(s.publishedTs), minutes_relative_to_move_start: s.minutesRelativeToMove, title: s.title, body: s.body })),
      bulk_block_deals_today: p.deals,
      surveillance: p.surveillance,
      sector_peers: p.peers,
      global_cues_pct: p.globalCues,
      priced_in: p.pricedIn,
      has_open_position: p.position ? { qty: p.position.qty } : null,
    },
    null,
    1,
  );
}
