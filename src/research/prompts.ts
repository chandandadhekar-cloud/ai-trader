// Versioned prompts and output schemas. Any change here requires re-running the
// golden-set regression eval (npm run eval:research) before deployment; the
// version string is stored on every verdict.

import { z } from 'zod';

export const PROMPT_VERSION = 'research-v1.0.0';

export const CAUSE_CATEGORIES = [
  'corporate_filing', 'results', 'order_win', 'regulatory_action', 'management_change', 'deal_flow',
  'sector_move', 'macro_index', 'rumor_social', 'technical_flow', 'no_identifiable_cause', 'other',
] as const;

export const ClaimSchema = z.object({
  text: z.string(),
  source_ids: z.array(z.string()),
});

export const VerdictSchema = z.object({
  cause_category: z.enum(CAUSE_CATEGORIES),
  cause_summary: z.string(),
  claims: z.array(ClaimSchema),
  cited_source_ids: z.array(z.string()),
  is_new_information: z.boolean(),
  first_seen_source_id: z.string().nullable(),
  expected_persistence: z.enum(['minutes', 'hours', 'days']),
  direction: z.enum(['UP', 'DOWN', 'NONE']),
  confidence: z.number(),
  proposed_verdict: z.enum(['REACT', 'FADE', 'PROTECT', 'IGNORE', 'BLOCK']),
  unknowns: z.array(z.string()),
});
export type LlmVerdict = z.infer<typeof VerdictSchema>;

export const AnalystNoteSchema = z.object({
  findings: z.array(ClaimSchema),
  stance: z.enum(['explains_move', 'contradicts_move', 'no_evidence']),
  direction: z.enum(['UP', 'DOWN', 'NONE']),
  confidence: z.number(),
  unknowns: z.array(z.string()),
});
export type AnalystNote = z.infer<typeof AnalystNoteSchema>;

const RULES = `Rules:
- Use ONLY the sources in the fact pack. Every claim must cite one or more source ids from it; claims without a valid id are discarded by code.
- Source priority: exchange_filing > press_release > wire > media > social. A cause supported only by social sources is a rumour: low confidence.
- A source published AFTER the move started (positive minutes_relative_to_move_start) is usually a post-hoc media explanation, not the cause. Say so explicitly and set is_new_information=false unless an earlier primary source exists.
- If the index or sector explains most of the move (explainedByIndex high, several peers moving the same way), the cause is macro_index or sector_move.
- If there is no supporting source, use cause_category=no_identifiable_cause and say what is unknown. Do not speculate.
- confidence is your probability (0 to 1) that the stated cause is correct and actually drove this move.
- You do not decide position size or place trades. proposed_verdict is a label that deterministic code will check:
  REACT = new, primary-sourced, material information likely to keep driving the price (drift);
  FADE = no identifiable cause, move likely to revert;
  PROTECT = an open position faces an adverse, verified cause;
  IGNORE = index-driven, stale, low confidence or immaterial;
  BLOCK = surveillance / circuit / ban restrictions or an unverifiable rumour make the symbol untradeable today.`;

export const FAST_SYSTEM = `You classify why an Indian-listed stock (or crypto perpetual) is moving, from a fact pack assembled by code. You are the fast path of a trading research pipeline: be precise and brief.
${RULES}`;

export function fastUser(factPackJson: string): string {
  return `Fact pack:\n${factPackJson}\n\nClassify the cause of this move.`;
}

export const ANALYST_ROLES = {
  filings: 'You are the FILINGS analyst. Examine only exchange filings and company press releases in the fact pack: what was disclosed, when, and whether it is material and new.',
  news: 'You are the NEWS/SOCIAL analyst. Examine wire, media and social sources: which report new facts, which merely explain the move after the fact, and which are unverified rumours.',
  structure: 'You are the MARKET-STRUCTURE analyst. Examine the move statistics, index/sector context, peers, bulk/block deals, open interest build-up, order-book imbalance and global cues. Decide whether the move is idiosyncratic or market-driven and whether flow looks one-sided or reverting.',
} as const;

export function analystUser(factPackJson: string): string {
  return `Fact pack:\n${factPackJson}\n\nReport your findings with citations.`;
}

export const SKEPTIC_SYSTEM = `You are the SKEPTIC on a research desk. Given analyst notes and the fact pack, argue the strongest case that the proposed explanation is wrong, stale, post-hoc, already priced in, or that the move will reverse. Cite source ids for every point.
${RULES}`;

export const JUDGE_SYSTEM = `You are the JUDGE on a research desk. Weigh the analyst notes and the skeptic's rebuttal against the fact pack and produce the final classification. Prefer primary sources, penalise post-hoc and social-only explanations, and state unknowns.
${RULES}`;

export function judgeUser(factPackJson: string, notes: Record<string, AnalystNote>, skeptic: AnalystNote): string {
  return `Fact pack:\n${factPackJson}\n\nAnalyst notes:\n${JSON.stringify(notes, null, 1)}\n\nSkeptic:\n${JSON.stringify(skeptic, null, 1)}\n\nGive the final classification.`;
}
