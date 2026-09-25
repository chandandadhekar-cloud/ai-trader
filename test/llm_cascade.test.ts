import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodTextFormat } from 'openai/helpers/zod';
import { runCascade, deterministicShortCircuit, type CascadeConfig } from '../src/research/agents.ts';
import { estimateCostUsd, type LlmClient, type StructuredCallOpts, type StructuredResult } from '../src/research/llm.ts';
import { VerdictSchema, AnalystNoteSchema, type LlmVerdict } from '../src/research/prompts.ts';
import type { FactPack, FactSource } from '../src/research/factPack.ts';

const T0 = 1_790_000_000_000;
const src = (id: string, minRel: number, title: string, lexicon = 1): FactSource => ({ id, kind: 'exchange_filing', rank: 1, source: 'NSE', title, publishedTs: T0 + minRel * 60_000, receivedTs: T0, minutesRelativeToMove: minRel, lexicon });
const pack = (sources: FactSource[], extra: Partial<FactPack> = {}): FactPack => ({
  id: 'FP', symbol: 'X', key: 'NSE_EQ|X', builtAt: T0, buildMs: 1,
  move: { detectedTs: T0, moveStartTs: T0 - 300_000, price: 100, retSinceStart: 0.03, z: 6, residualZ: 5, explainedByIndex: 0.1 },
  sources, deals: [], surveillance: null, peers: { total: 0, sameDirection: 0, symbols: [] }, globalCues: {}, pricedIn: {}, sourceErrors: [], sourceHash: 'h', ...extra,
});
const v = (o: Partial<LlmVerdict> = {}): LlmVerdict => ({
  cause_category: 'order_win', cause_summary: 's', claims: [{ text: 'c', source_ids: ['F1'] }], cited_source_ids: ['F1'], is_new_information: true,
  first_seen_source_id: 'F1', expected_persistence: 'days', direction: 'UP', confidence: 0.9, proposed_verdict: 'REACT', unknowns: [], ...o,
});
const note = { findings: [], stance: 'explains_move' as const, direction: 'UP' as const, confidence: 0.7, unknowns: [] };

class FakeLlm implements LlmClient {
  calls: { model: string; purpose: string }[] = [];
  answers: Record<string, unknown[]>;
  constructor(answers: Record<string, unknown[]>) { this.answers = answers; }
  available() { return true; }
  async call<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
    this.calls.push({ model: o.model, purpose: o.purpose });
    const key = o.purpose.startsWith('deep.judge') ? 'judge' : o.purpose.startsWith('deep.') ? 'note' : 'fast';
    const q = this.answers[key];
    const value = (q.length > 1 ? q.shift() : q[0]) as T;
    return { value, model: o.model, latencyMs: 1, inputTokens: 1000, cachedTokens: 0, outputTokens: 100, costUsd: estimateCostUsd(o.model, 1000, 0, 100) };
  }
  usageToday() { return { calls: this.calls.length, costUsd: 0, errors: 0, byModel: {} }; }
}

const cfg: CascadeConfig = { fastModel: 'gpt-6-luna', deepModel: 'gpt-6-sol', fastTimeoutMs: 1000, deepTimeoutMs: 5000, fastEffort: 'low', deepEffort: 'medium', deepAllowed: true, forceDeep: false, unsureLow: 0.35, unsureHigh: 0.75 };
const strong = (l: FakeLlm) => l.calls.filter((c) => c.model === 'gpt-6-sol').length;

test('schemas are valid strict structured-output formats', () => {
  assert.equal(zodTextFormat(VerdictSchema, 'verdict').type, 'json_schema');
  assert.equal(zodTextFormat(AnalystNoteSchema, 'analyst_note').strict, true);
});

test('rules settle obvious cases with zero LLM calls', async () => {
  const llm = new FakeLlm({ fast: [v()] });
  assert.equal(deterministicShortCircuit(pack([])), 'no-sources');
  assert.equal(deterministicShortCircuit(pack([], { move: { detectedTs: T0, moveStartTs: T0, price: 1, explainedByIndex: 0.9 } })), 'index-driven');
  assert.equal(deterministicShortCircuit(pack([src('F1', -2, 'x')], { surveillance: { gsm: 1 } })), 'surveillance-restricted');
  const r = await runCascade(llm, pack([]), cfg);
  assert.equal(r.path, 'deterministic');
  assert.equal(llm.calls.length, 0);
});

test('a confident non-actionable fast verdict never touches the strong model', async () => {
  const llm = new FakeLlm({ fast: [v({ proposed_verdict: 'IGNORE', direction: 'NONE', confidence: 0.9 })] });
  const r = await runCascade(llm, pack([src('F1', -2, 'AGM notice', 0)]), cfg);
  assert.equal(r.path, 'fast');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, 'gpt-6-luna');
});

test('an actionable REACT escalates; one strong judge suffices when it agrees with the fast model', async () => {
  const llm = new FakeLlm({ fast: [v()], note: [note], judge: [v({ confidence: 0.8 })] });
  const r = await runCascade(llm, pack([src('F1', -2, 'wins order')]), cfg);
  assert.equal(r.path, 'deep');
  assert.equal(r.verdict?.proposed_verdict, 'REACT');
  assert.equal(r.verdict?.confidence, 0.8); // min of agreeing votes
  assert.equal(strong(llm), 1);
  assert.equal(llm.calls.filter((c) => c.model === 'gpt-6-luna').length, 5); // fast + 3 analysts + skeptic
});

test('disagreement triggers a second strong judge; majority wins, no majority → UNCERTAIN', async () => {
  const a = new FakeLlm({ fast: [v()], note: [note], judge: [v({ proposed_verdict: 'IGNORE', direction: 'NONE' }), v()] });
  const ra = await runCascade(a, pack([src('F1', -2, 'wins order')]), cfg);
  assert.equal(strong(a), 2);
  assert.equal(ra.verdict?.proposed_verdict, 'REACT'); // fast + judge2 agree
  const b = new FakeLlm({ fast: [v()], note: [note], judge: [v({ proposed_verdict: 'IGNORE', direction: 'NONE' }), v({ proposed_verdict: 'FADE', direction: 'DOWN' })] });
  const rb = await runCascade(b, pack([src('F1', -2, 'wins order')]), cfg);
  assert.equal(rb.uncertain, true);
  assert.equal(rb.verdict, undefined);
});

test('unsure fast confidence escalates; exhausted deep budget falls back to the fast verdict', async () => {
  const llm = new FakeLlm({ fast: [v({ proposed_verdict: 'IGNORE', direction: 'NONE', confidence: 0.5 })], note: [note], judge: [v({ proposed_verdict: 'IGNORE', direction: 'NONE' })] });
  const r = await runCascade(llm, pack([src('F1', -2, 'x', 0)]), cfg);
  assert.match(String(r.trace.escalation), /unsure/);
  const capped = new FakeLlm({ fast: [v()] });
  const rc = await runCascade(capped, pack([src('F1', -2, 'wins order')]), { ...cfg, deepAllowed: false });
  assert.equal(rc.path, 'fast');
  assert.equal(strong(capped), 0);
  assert.match(String(rc.trace.escalation), /budget exhausted/);
});

test('fast direction contradicting the primary source wording escalates', async () => {
  const llm = new FakeLlm({ fast: [v({ proposed_verdict: 'FADE', direction: 'DOWN', confidence: 0.9 })], note: [note], judge: [v({ proposed_verdict: 'FADE', direction: 'DOWN' })] });
  const r = await runCascade(llm, pack([src('F1', -2, 'wins order', 1)]), cfg);
  assert.match(String(r.trace.escalation), /contradicts/);
});

test('cost model prices cached input at 10%', () => {
  assert.ok(Math.abs(estimateCostUsd('gpt-6-luna', 1_000_000, 0, 1_000_000) - 0.6) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd('gpt-6-sol', 1_000_000, 1_000_000, 0) - 0.2) < 1e-9);
});
