// Stage 1 (fast) and Stage 2 (deep) research agents (plan §C).
//  - Cascade for cost: hard facts decide without an LLM; a cheap model triages;
//    the strong model is used only for actionable or unsure decisions.
//  - Fast: one structured call on the cheap model with a hard timeout.
//  - Deep: filings / news / market-structure analysts and a skeptic (cheap model),
//    then a strong-model judge that must agree with the independent fast verdict
//    (a second judge breaks ties); otherwise UNCERTAIN.
//  - Deterministic fallback when no LLM is configured: local lexicon over primary
//    sources, clearly labelled `deterministic`, with conservative confidence.

import type { Effort, LlmClient, StructuredResult } from './llm.ts';
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

export interface CascadeConfig {
  fastModel: string;
  deepModel: string;
  fastTimeoutMs: number;
  deepTimeoutMs: number;
  fastEffort: Effort;
  deepEffort: Effort;
  /** Deep budget available (hourly cap not exhausted). */
  deepAllowed: boolean;
  /** Always escalate (open position / very high severity / manual deep request). */
  forceDeep: boolean;
  /** Fast-path confidence band that is "unsure" and escalates. */
  unsureLow: number;
  unsureHigh: number;
}

const merge = (a: AgentRun, b: AgentRun): AgentRun => ({ ...b, latencyMs: a.latencyMs + b.latencyMs, costUsd: a.costUsd + b.costUsd, trace: { ...a.trace, ...b.trace } });

export async function runFast(llm: LlmClient, pack: FactPack, model: string, timeoutMs: number, effort: Effort = 'low'): Promise<AgentRun> {
  const t0 = Date.now();
  try {
    const r = await llm.call({ model, system: FAST_SYSTEM, user: fastUser(factPackForPrompt(pack)), schema: VerdictSchema, schemaName: 'verdict', timeoutMs, effort, maxTokens: 3000, purpose: 'fast' });
    return { verdict: r.value, uncertain: false, path: 'fast', model: r.model, latencyMs: Date.now() - t0, costUsd: r.costUsd, trace: { fast: r.value } };
  } catch (e) {
    return { uncertain: true, path: 'fast', model, latencyMs: Date.now() - t0, costUsd: 0, error: String((e as Error).message ?? e), trace: {} };
  }
}

/**
 * Deep path, cost-shaped: the three analysts and the skeptic run on the cheap
 * model (parallel, low effort); only the judge runs on the strong model.
 * Self-consistency across models: the judge must agree with the independent
 * fast-path verdict; on disagreement a second strong-model judge breaks the tie
 * (2 of 3), otherwise UNCERTAIN.
 */
export async function runDeep(llm: LlmClient, pack: FactPack, cfg: Pick<CascadeConfig, 'fastModel' | 'deepModel' | 'deepTimeoutMs' | 'deepEffort'>, fast?: LlmVerdict): Promise<AgentRun> {
  const t0 = Date.now();
  const json = factPackForPrompt(pack);
  let cost = 0;
  const trace: Record<string, unknown> = {};
  const deadline = t0 + cfg.deepTimeoutMs;
  const left = () => Math.max(5_000, deadline - Date.now());
  const add = <T>(r: StructuredResult<T>) => { cost += r.costUsd; return r.value; };
  try {
    const roles = Object.entries(ANALYST_ROLES) as [keyof typeof ANALYST_ROLES, string][];
    const notesArr = await Promise.all(
      roles.map(([name, sys]) =>
        llm.call({ model: cfg.fastModel, system: `${sys}\n${FAST_SYSTEM}`, user: analystUser(json), schema: AnalystNoteSchema, schemaName: 'analyst_note', timeoutMs: left() / 3, effort: 'low', maxTokens: 3000, purpose: `deep.${name}` }).then(add),
      ),
    );
    const notes = Object.fromEntries(roles.map(([n], i) => [n, notesArr[i]])) as Record<string, AnalystNote>;
    trace.notes = notes;
    const skeptic = add(await llm.call({ model: cfg.fastModel, system: SKEPTIC_SYSTEM, user: analystUser(`${json}\n\nAnalyst notes:\n${JSON.stringify(notes)}`), schema: AnalystNoteSchema, schemaName: 'analyst_note', timeoutMs: left() / 3, effort: 'low', maxTokens: 3000, purpose: 'deep.skeptic' }));
    trace.skeptic = skeptic;
    const judge = (order: Record<string, AnalystNote>, tag: string) =>
      llm.call({ model: cfg.deepModel, system: JUDGE_SYSTEM, user: judgeUser(json, order, skeptic), schema: VerdictSchema, schemaName: 'verdict', timeoutMs: left(), effort: cfg.deepEffort, maxTokens: 6000, purpose: `deep.${tag}` }).then(add);
    const j1 = await judge(notes, 'judge1');
    const votes: LlmVerdict[] = [j1];
    if (fast) votes.push(fast);
    const same = (a: LlmVerdict, b: LlmVerdict) => a.proposed_verdict === b.proposed_verdict && a.direction === b.direction;
    if (!fast || !same(j1, fast)) {
      const reversed = Object.fromEntries(Object.entries(notes).reverse()) as Record<string, AnalystNote>;
      votes.push(await judge(reversed, 'judge2'));
    }
    trace.judges = votes;
    // Majority over {judge1, fast?, judge2?}; the strong-model judgement wins ties of content.
    const winner = votes.find((v) => votes.filter((w) => same(v, w)).length >= 2);
    const verdict = winner ? { ...(same(winner, j1) ? j1 : winner), confidence: Math.min(...votes.filter((w) => same(winner, w)).map((w) => w.confidence)) } : undefined;
    return { verdict, uncertain: !verdict, path: 'deep', model: cfg.deepModel, latencyMs: Date.now() - t0, costUsd: cost, trace };
  } catch (e) {
    return { uncertain: true, path: 'deep', model: cfg.deepModel, latencyMs: Date.now() - t0, costUsd: cost, error: String((e as Error).message ?? e), trace };
  }
}

/**
 * Hard facts decide without any LLM call (cheapest and most reliable):
 * surveillance-restricted names, index-driven moves, and moves with no sources
 * at all when nothing is held.
 */
export function deterministicShortCircuit(pack: FactPack): string | undefined {
  const sv = pack.surveillance as { gsm?: number; ltAsm?: number; stAsm?: number; esm?: number; ibc?: boolean; series?: string } | null;
  if (sv && (sv.gsm || (sv.ltAsm ?? 0) >= 2 || (sv.stAsm ?? 0) >= 2 || sv.esm || sv.ibc)) return 'surveillance-restricted';
  if (!pack.position && (pack.move.explainedByIndex ?? 0) > 0.7 && !pack.sources.some((s) => s.rank <= 3 && s.minutesRelativeToMove <= 1)) return 'index-driven';
  if (!pack.position && pack.sources.length === 0) return 'no-sources';
  return undefined;
}

/**
 * The cascade: rules → cheap fast model → strong model only when the decision
 * is actionable (REACT / PROTECT), unsure, contradicted by the primary source's
 * wording, or forced (open position / high severity).
 */
export async function runCascade(llm: LlmClient, pack: FactPack, cfg: CascadeConfig): Promise<AgentRun> {
  const short = deterministicShortCircuit(pack);
  if (!llm.available() || (short && !cfg.forceDeep)) {
    const d = runDeterministic(pack);
    d.trace.shortCircuit = short ?? 'no-llm';
    return d;
  }
  const fast = await runFast(llm, pack, cfg.fastModel, cfg.fastTimeoutMs, cfg.fastEffort);
  const v = fast.verdict;
  const reasons: string[] = [];
  if (cfg.forceDeep) reasons.push('forced (position / severity / manual)');
  if (!v) reasons.push('fast path failed');
  if (v && (v.proposed_verdict === 'REACT' || v.proposed_verdict === 'PROTECT')) reasons.push(`actionable ${v.proposed_verdict}`);
  if (v && v.confidence >= cfg.unsureLow && v.confidence <= cfg.unsureHigh) reasons.push(`unsure (${v.confidence.toFixed(2)})`);
  const lead = pack.sources.filter((s) => s.rank <= 3).sort((a, b) => Math.abs(b.lexicon) - Math.abs(a.lexicon))[0];
  if (v && lead && Math.abs(lead.lexicon) >= 0.5 && v.direction !== 'NONE' && Math.sign(lead.lexicon) !== (v.direction === 'UP' ? 1 : -1)) reasons.push('contradicts primary-source wording');
  if (!reasons.length || !cfg.deepAllowed) {
    fast.trace.escalation = reasons.length ? `wanted (${reasons.join('; ')}) but deep budget exhausted` : 'not needed';
    if (!v) return merge(fast, runDeterministic(pack));
    return fast;
  }
  const deep = await runDeep(llm, pack, cfg, v);
  deep.trace.escalation = reasons.join('; ');
  if (deep.error && v) return { ...merge(deep, fast), path: 'fast', uncertain: false, trace: { ...deep.trace, ...fast.trace, deepError: deep.error } };
  return merge(fast, deep);
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
