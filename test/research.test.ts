import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyVerdict, citationValidity } from '../src/research/verify.ts';
import { mapVerdict } from '../src/research/verdictMapper.ts';
import { runDeterministic } from '../src/research/agents.ts';
import { dedupe, parseNseDate } from '../src/research/sources.ts';
import { lexiconScore } from '../src/research/localNlp.ts';
import { ResearchConfigSchema } from '../src/config/runtime.ts';
import type { FactPack, FactSource } from '../src/research/factPack.ts';
import type { LlmVerdict } from '../src/research/prompts.ts';

const T0 = 1_790_000_000_000;
const src = (id: string, kind: FactSource['kind'], minRel: number, title = 'X wins large order'): FactSource => ({
  id, kind, rank: { exchange_filing: 1, press_release: 2, wire: 3, media: 4, social: 5 }[kind], source: kind, title,
  publishedTs: T0 - 5 * 60_000 + minRel * 60_000, receivedTs: T0, minutesRelativeToMove: minRel, lexicon: lexiconScore(title).score,
});
const pack = (sources: FactSource[], extra: Partial<FactPack> = {}): FactPack => ({
  id: 'FP', symbol: 'X', key: 'NSE_EQ|X', builtAt: T0, buildMs: 5,
  move: { detectedTs: T0, moveStartTs: T0 - 5 * 60_000, price: 100, retSinceStart: 0.03, z: 6, residualZ: 5 },
  sources, deals: [], surveillance: null, peers: { total: 5, sameDirection: 0, symbols: [] }, globalCues: {},
  pricedIn: { fractionOfTypical: 0.3, minutesSinceFirstPublication: 6 }, sourceErrors: [], sourceHash: 'h', ...extra,
});
const verdict = (o: Partial<LlmVerdict> = {}): LlmVerdict => ({
  cause_category: 'order_win', cause_summary: 'Order win', claims: [{ text: 'Won an order', source_ids: ['F1'] }], cited_source_ids: ['F1'],
  is_new_information: true, first_seen_source_id: 'F1', expected_persistence: 'days', direction: 'UP', confidence: 0.9, proposed_verdict: 'REACT', unknowns: [], ...o,
});
const cfg = ResearchConfigSchema.parse({});
const base = { isDerivative: false, nearBand: false, bandLocked: false, cfg, anomaly: { id: 'A', key: 'NSE_EQ|X', symbol: 'X', type: 'RETURN_SHOCK' as const, ts: T0, severity: 80, price: 100, tier: 'A' as const, details: {}, ret: 0.03, z: 6, residualZ: 5 } };

test('citations: invented source ids are removed and uncited claims dropped', () => {
  const p = pack([src('F1', 'exchange_filing', -2)]);
  const v = verifyVerdict(verdict({ claims: [{ text: 'real', source_ids: ['F1'] }, { text: 'made up', source_ids: ['NOPE'] }], cited_source_ids: ['F1', 'NOPE'] }), p);
  assert.equal(v.droppedClaims, 1);
  assert.deepEqual(v.citedIds, ['F1']);
  assert.deepEqual(v.invalidIds, ['NOPE']);
  assert.equal(citationValidity(verdict({ cited_source_ids: ['F1', 'NOPE'], claims: [] }), p), 0.5);
});

test('a fresh primary-sourced filing before the move maps to REACT', () => {
  const p = pack([src('F1', 'exchange_filing', -2)]);
  const v = verifyVerdict(verdict(), p);
  const r = mapVerdict({ ...base, verified: v, pack: p, calibratedConfidence: 0.7 });
  assert.equal(r.final, 'REACT');
});

test('post-hoc media explanation cannot produce REACT', () => {
  const p = pack([src('M1', 'media', 3, 'Why X shares are rallying today')]);
  const v = verifyVerdict(verdict({ cited_source_ids: ['M1'], claims: [{ text: 'media says', source_ids: ['M1'] }] }), p);
  assert.equal(v.postHoc, true);
  assert.equal(v.isNew, false);
  assert.notEqual(mapVerdict({ ...base, verified: v, pack: p, calibratedConfidence: 0.7 }).final, 'REACT');
});

test('priced-in or stale news downgrades REACT to IGNORE', () => {
  const p = pack([src('F1', 'exchange_filing', -2)], { pricedIn: { fractionOfTypical: 0.85, minutesSinceFirstPublication: 6 } });
  const r = mapVerdict({ ...base, verified: verifyVerdict(verdict(), p), pack: p, calibratedConfidence: 0.7 });
  assert.equal(r.final, 'IGNORE');
  assert.ok(r.reasons.some((x) => /priced in/.test(x)));
  const stale = pack([src('F1', 'exchange_filing', -2)], { pricedIn: { fractionOfTypical: 0.2, minutesSinceFirstPublication: 45 } });
  assert.equal(mapVerdict({ ...base, verified: verifyVerdict(verdict(), stale), pack: stale, calibratedConfidence: 0.7 }).final, 'IGNORE');
});

test('social-only rumours are capped and blocked; surveillance / band-lock force BLOCK', () => {
  const p = pack([src('S1', 'social', -1, 'rumour: X takeover')]);
  const v = verifyVerdict(verdict({ cause_category: 'rumor_social', cited_source_ids: ['S1'], claims: [{ text: 'rumour', source_ids: ['S1'] }] }), p);
  assert.ok(v.confidence <= 0.3);
  assert.equal(mapVerdict({ ...base, verified: v, pack: p, calibratedConfidence: 0.3 }).final, 'BLOCK');
  const gsm = pack([src('F1', 'exchange_filing', -2)], { surveillance: { gsm: 2 } });
  assert.equal(mapVerdict({ ...base, verified: verifyVerdict(verdict(), gsm), pack: gsm, calibratedConfidence: 0.9 }).final, 'BLOCK');
  const p2 = pack([src('F1', 'exchange_filing', -2)]);
  assert.equal(mapVerdict({ ...base, verified: verifyVerdict(verdict(), p2), pack: p2, calibratedConfidence: 0.9, bandLocked: true }).final, 'BLOCK');
});

test('no cause + extreme residual + non-one-sided flow maps to FADE; index-driven to IGNORE', () => {
  const p = pack([], { move: { detectedTs: T0, moveStartTs: T0, price: 100, retSinceStart: 0.03, imbalance: -0.3 } });
  const v = verifyVerdict(verdict({ cause_category: 'no_identifiable_cause', claims: [], cited_source_ids: [], direction: 'NONE', proposed_verdict: 'FADE', confidence: 0.5 }), p);
  assert.equal(mapVerdict({ ...base, verified: v, pack: p, calibratedConfidence: 0.5 }).final, 'FADE');
  const oneSided = pack([], { move: { detectedTs: T0, moveStartTs: T0, price: 100, retSinceStart: 0.03, imbalance: 0.5 } });
  assert.equal(mapVerdict({ ...base, verified: verifyVerdict(verdict({ cause_category: 'no_identifiable_cause', claims: [], cited_source_ids: [] }), oneSided), pack: oneSided, calibratedConfidence: 0.5 }).final, 'IGNORE');
  const idx = mapVerdict({ ...base, anomaly: { ...base.anomaly, suppressed: true }, verified: v, pack: p, calibratedConfidence: 0.5 });
  assert.equal(idx.final, 'IGNORE');
});

test('open position facing an adverse verified cause maps to PROTECT', () => {
  const p = pack([src('F1', 'exchange_filing', -2, 'X results miss; profit falls')], { position: { qty: 100, avgPrice: 100 } });
  const v = verifyVerdict(verdict({ direction: 'DOWN', cause_category: 'results' }), p);
  assert.equal(mapVerdict({ ...base, verified: v, pack: p, calibratedConfidence: 0.5 }).final, 'PROTECT');
});

test('self-consistency disagreement yields UNCERTAIN', () => {
  assert.equal(mapVerdict({ ...base, uncertain: true, pack: pack([]), calibratedConfidence: 0 }).final, 'UNCERTAIN');
});

test('deterministic fallback uses pre-move primary sources and the lexicon', () => {
  const r = runDeterministic(pack([src('F1', 'exchange_filing', -2, 'X bags order worth 500 cr')]));
  assert.equal(r.verdict!.direction, 'UP');
  assert.equal(r.verdict!.proposed_verdict, 'REACT');
  assert.equal(runDeterministic(pack([])).verdict!.proposed_verdict, 'FADE');
});

test('source helpers: dedupe keeps the primary source; NSE dates are IST', () => {
  const d = dedupe([
    { id: 'm', kind: 'media', source: 'm', title: 'X Ltd wins big order from railways', publishedTs: 2, receivedTs: 2 },
    { id: 'f', kind: 'exchange_filing', source: 'NSE', title: 'X Ltd wins big order from railways', publishedTs: 1, receivedTs: 1 },
  ]);
  assert.deepEqual(d.map((x) => x.id), ['f']);
  assert.equal(parseNseDate('25-Sep-2026 14:05:31'), Date.UTC(2026, 8, 25, 8, 35, 31));
});
