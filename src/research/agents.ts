// Stage 1 (fast) and Stage 2 (deep) research agents (plan §C).
//  - Fast: one structured call on a fast model with a hard timeout (5–20 s budget).
//  - Deep: filings / news / market-structure analysts in parallel, a skeptic, then
//    two independent judges (self-consistency). The verdict stands only if both
//    judges agree on label and direction; otherwise UNCERTAIN.
//  - Deterministic fallback when no LLM is configured: local lexicon over primary
//    sources, clearly labelled `deterministic`, with conservative confidence.

import type { LlmClient, StructuredResult } from './llm.ts';
import type { FactPack } from './factPack.ts';
import { factPackForPrompt } from './factPack.ts';
import {
  ANALYST_ROLES, AnalystNoteSchema, FAST_SYSTEM, JUDGE_SYSTEM, SKEPTIC_SYSTEM, VerdictSchema,
  analystUser, fastUser, judgeUser, type AnalystNote, type LlmVerdict,
} from './prompts.ts';

export interface AgentRun {
  verdict?: LlmVerdict;
  uncertain: boolean;
  path: 'fast' | 'deep' | 'deterministic';
  model?: string;
  latencyMs: number;
  costUsd: number;
  error?: string;
  trace: Record<string, unknown>;
}

export async function runFast(llm: LlmClient, pack: FactPack, model: string, timeoutMs: number): Promise<AgentRun> {
  const t0 = Date.now();
  try {
    const r = await llm.call({ model, system: FAST_SYSTEM, user: fastUser(factPackForPrompt(pack)), schema: VerdictSchema, timeoutMs, maxTokens: 1500, purpose: 'fast' });
    return { verdict: r.value, uncertain: false, path: 'fast', model: r.model, latencyMs: Date.now() - t0, costUsd: r.costUsd, trace: {} };
  } catch (e) {
    return { uncertain: true, path: 'fast', model, latencyMs: Date.now() - t0, costUsd: 0, error: String((e as Error).message ?? e), trace: {} };
  }
}

export async function runDeep(llm: LlmClient, pack: FactPack, model: string, timeoutMs: number): Promise<AgentRun> {
  const t0 = Date.now();
  const json = factPackForPrompt(pack);
  let cost = 0;
  const trace: Record<string, unknown> = {};
  const deadline = t0 + timeoutMs;
  const left = () => Math.max(5_000, deadline - Date.now());
  const add = <T>(r: StructuredResult<T>) => { cost += r.costUsd; return r.value; };
  try {
    const roles = Object.entries(ANALYST_ROLES) as [keyof typeof ANALYST_ROLES, string][];
    const notesArr = await Promise.all(
      roles.map(([name, sys]) =>
        llm.call({ model, system: `${sys}\n${FAST_SYSTEM}`, user: analystUser(json), schema: AnalystNoteSchema, timeoutMs: left() / 2, effort: 'low', maxTokens: 2000, purpose: `deep.${name}` }).then(add),
      ),
    );
    const notes = Object.fromEntries(roles.map(([n], i) => [n, notesArr[i]])) as Record<string, AnalystNote>;
    trace.notes = notes;
    const skeptic = add(await llm.call({ model, system: SKEPTIC_SYSTEM, user: analystUser(`${json}\n\nAnalyst notes:\n${JSON.stringify(notes)}`), schema: AnalystNoteSchema, timeoutMs: left() / 2, effort: 'low', maxTokens: 2000, purpose: 'deep.skeptic' }));
    trace.skeptic = skeptic;
    // Two independent judges; the second sees the notes in reverse order.
    const reversed = Object.fromEntries(Object.entries(notes).reverse()) as Record<string, AnalystNote>;
    const [j1, j2] = await Promise.all([
      llm.call({ model, system: JUDGE_SYSTEM, user: judgeUser(json, notes, skeptic), schema: VerdictSchema, timeoutMs: left(), effort: 'medium', maxTokens: 3000, purpose: 'deep.judge1' }).then(add),
      llm.call({ model, system: JUDGE_SYSTEM, user: judgeUser(json, reversed, skeptic), schema: VerdictSchema, timeoutMs: left(), effort: 'medium', maxTokens: 3000, purpose: 'deep.judge2' }).then(add),
    ]);
    trace.judges = [j1, j2];
    const agree = j1.proposed_verdict === j2.proposed_verdict && j1.direction === j2.direction;
    const verdict = agree ? { ...j1, confidence: Math.min(j1.confidence, j2.confidence) } : undefined;
    return { verdict, uncertain: !agree, path: 'deep', model, latencyMs: Date.now() - t0, costUsd: cost, trace };
  } catch (e) {
    return { uncertain: true, path: 'deep', model, latencyMs: Date.now() - t0, costUsd: cost, error: String((e as Error).message ?? e), trace };
  }
}

/** No-LLM fallback: primary sources published before the move + lexicon direction. */
export function runDeterministic(pack: FactPack): AgentRun {
  const t0 = Date.now();
  const pre = pack.sources.filter((s) => s.rank <= 3 && s.minutesRelativeToMove <= 1);
  const post = pack.sources.filter((s) => s.minutesRelativeToMove > 1);
  const moveDir = Math.sign(pack.move.retSinceStart ?? 0);
  let verdict: LlmVerdict;
  if (pack.move.explainedByIndex !== undefined && pack.move.explainedByIndex > 0.7) {
    verdict = base('macro_index', 'Move largely explained by the index.', [], 'NONE', 0.6, 'IGNORE');
  } else if (pre.length) {
    const s = pre.sort((a, b) => b.lexicon * moveDir - a.lexicon * moveDir)[0];
    const dir = s.lexicon > 0 ? 'UP' : s.lexicon < 0 ? 'DOWN' : 'NONE';
    verdict = base('corporate_filing', `Primary source before the move: ${s.title}`, [s.id], dir, Math.abs(s.lexicon) > 0 ? 0.65 : 0.4, dir !== 'NONE' ? 'REACT' : 'IGNORE');
    verdict.is_new_information = true;
    verdict.first_seen_source_id = s.id;
  } else if (post.length) {
    verdict = base('other', 'Only sources published after the move began (post-hoc).', [post[0].id], 'NONE', 0.3, 'IGNORE');
  } else {
    verdict = base('no_identifiable_cause', 'No source explains the move.', [], 'NONE', 0.5, 'FADE');
  }
  return { verdict, uncertain: false, path: 'deterministic', latencyMs: Date.now() - t0, costUsd: 0, trace: { rule: verdict.cause_category } };
}

function base(cat: LlmVerdict['cause_category'], summary: string, ids: string[], dir: LlmVerdict['direction'], conf: number, prop: LlmVerdict['proposed_verdict']): LlmVerdict {
  return {
    cause_category: cat, cause_summary: summary,
    claims: ids.length ? [{ text: summary, source_ids: ids }] : [],
    cited_source_ids: ids, is_new_information: false, first_seen_source_id: ids[0] ?? null,
    expected_persistence: prop === 'REACT' ? 'days' : 'minutes', direction: dir, confidence: conf, proposed_verdict: prop,
    unknowns: ids.length ? [] : ['cause of move'],
  };
}
