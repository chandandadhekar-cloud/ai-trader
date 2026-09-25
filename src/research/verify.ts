// Hallucination and verification controls (plan §C). Code, not the model, decides
// what survives:
//  - citations are mandatory: unknown ids are removed; claims with no valid id are dropped
//  - primary-source priority: social-only causes are capped at low confidence
//  - timestamp check: causes published after the move began are post-hoc
//  - first_seen_ts is computed from the cited sources, not taken from the model
//  - confidence is clamped to [0, 1]

import type { FactPack } from './factPack.ts';
import type { LlmVerdict } from './prompts.ts';

export interface VerifiedVerdict {
  raw: LlmVerdict;
  claims: { text: string; sourceIds: string[] }[];
  droppedClaims: number;
  citedIds: string[];
  invalidIds: string[];
  bestRank?: number;
  socialOnly: boolean;
  postHoc: boolean;
  firstSeenTs?: number;
  isNew: boolean;
  confidence: number;
  category: string;
  notes: string[];
}

/** Grace for clock/feed differences when comparing publication with move start. */
const POST_HOC_GRACE_MIN = 1;

export function verifyVerdict(v: LlmVerdict, pack: FactPack): VerifiedVerdict {
  const valid = new Map(pack.sources.map((s) => [s.id, s]));
  const notes: string[] = [];
  const invalid = new Set<string>();
  const claims: { text: string; sourceIds: string[] }[] = [];
  let dropped = 0;
  for (const c of v.claims) {
    const ids = c.source_ids.filter((id) => {
      if (valid.has(id)) return true;
      invalid.add(id);
      return false;
    });
    if (ids.length) claims.push({ text: c.text, sourceIds: ids });
    else dropped++;
  }
  for (const id of v.cited_source_ids) if (!valid.has(id)) invalid.add(id);
  const cited = [...new Set([...v.cited_source_ids.filter((id) => valid.has(id)), ...claims.flatMap((c) => c.sourceIds)])];
  const citedSrc = cited.map((id) => valid.get(id)!);
  if (invalid.size) notes.push(`removed ${invalid.size} invalid source id(s): ${[...invalid].slice(0, 5).join(', ')}`);
  if (dropped) notes.push(`dropped ${dropped} uncited claim(s)`);

  const bestRank = citedSrc.length ? Math.min(...citedSrc.map((s) => s.rank)) : undefined;
  const socialOnly = citedSrc.length > 0 && citedSrc.every((s) => s.kind === 'social');
  const preMove = citedSrc.filter((s) => s.minutesRelativeToMove <= POST_HOC_GRACE_MIN);
  const postHoc = citedSrc.length > 0 && preMove.length === 0;
  const firstSeenTs = citedSrc.length ? Math.min(...citedSrc.map((s) => s.publishedTs)) : undefined;

  let confidence = Math.min(1, Math.max(0, Number.isFinite(v.confidence) ? v.confidence : 0));
  let category: string = v.cause_category;
  let isNew = v.is_new_information;

  if (socialOnly) {
    confidence = Math.min(confidence, 0.3);
    notes.push('social-only cause: confidence capped at 0.3');
  }
  if (postHoc) {
    isNew = false;
    confidence = Math.min(confidence, 0.4);
    notes.push('all cited sources published after the move began (post-hoc explanation)');
  }
  if (!cited.length && category !== 'no_identifiable_cause' && category !== 'macro_index' && category !== 'sector_move' && category !== 'technical_flow') {
    notes.push(`no valid citations for "${category}": treated as unverified`);
    category = 'no_identifiable_cause';
    confidence = Math.min(confidence, 0.2);
    isNew = false;
  }
  if (v.first_seen_source_id && firstSeenTs && valid.get(v.first_seen_source_id)?.publishedTs !== firstSeenTs) {
    notes.push('model first_seen_source_id is not the earliest cited source; using computed first-seen time');
  }
  return { raw: v, claims, droppedClaims: dropped, citedIds: cited, invalidIds: [...invalid], bestRank, socialOnly, postHoc, firstSeenTs, isNew, confidence, category, notes };
}

/** Citation validity metric for evals: share of cited ids that exist in the pack. */
export function citationValidity(v: LlmVerdict, pack: FactPack): number {
  const ids = [...v.cited_source_ids, ...v.claims.flatMap((c) => c.source_ids)];
  if (!ids.length) return 1;
  const valid = new Set(pack.sources.map((s) => s.id));
  return ids.filter((id) => valid.has(id)).length / ids.length;
}
