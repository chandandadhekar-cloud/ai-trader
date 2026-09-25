// Verdict → deterministic action proposal (plan §C table). The model proposes a
// label; this code decides, from verified facts:
//   BLOCK   band-lock, GSM/ASM(tight)/ESM/IBC/T2T, F&O ban, unverifiable rumour
//   PROTECT open position + adverse verified cause
//   REACT   new, primary-sourced, material; not priced in; fresh; liquid; not near band
//   FADE    no identifiable cause, high residual, no filing, flow not one-sided, not near band
//   IGNORE  index-driven, stale, low confidence, anything else
// Priced-in rule: if > pricedInFraction of the typical impact is done, or the first
// publication is older than maxNewsAgeMin, REACT is downgraded to IGNORE (the
// initial reaction is not tradable, only the drift is — Lopez-Lira & Tang).

import type { Anomaly, Verdict } from '../core/types.ts';
import type { ResearchConfig } from '../config/runtime.ts';
import type { FactPack } from './factPack.ts';
import type { VerifiedVerdict } from './verify.ts';
import { T2T_SERIES } from '../surveillance/tradability.ts';

export interface MapInput {
  verified?: VerifiedVerdict;
  /** Self-consistency disagreement or LLM failure. */
  uncertain?: boolean;
  pack: FactPack;
  anomaly?: Anomaly;
  calibratedConfidence: number;
  isDerivative: boolean;
  nearBand: boolean;
  bandLocked: boolean;
  minuteTurnover?: number;
  cfg: ResearchConfig;
  minTurnoverInr?: number;
}

export interface MapResult {
  final: Verdict;
  reasons: string[];
}

export function mapVerdict(m: MapInput): MapResult {
  const reasons: string[] = [];
  const sv = m.pack.surveillance as { gsm?: number; ltAsm?: number; stAsm?: number; esm?: number; ibc?: boolean; inFnoBan?: boolean; series?: string } | null;
  const v = m.verified;
  const dir = v?.raw.direction ?? 'NONE';

  // BLOCK — hard facts first; the model cannot talk its way past these.
  const block: string[] = [];
  if (m.bandLocked) block.push('price locked at band (exit-impossible risk)');
  if (sv?.gsm) block.push(`GSM stage ${sv.gsm}`);
  if ((sv?.ltAsm ?? 0) >= 2) block.push(`LT-ASM stage ${sv?.ltAsm}`);
  if ((sv?.stAsm ?? 0) >= 2) block.push(`ST-ASM stage ${sv?.stAsm}`);
  if (sv?.esm) block.push('ESM');
  if (sv?.ibc) block.push('IBC');
  if (sv?.series && T2T_SERIES.has(sv.series)) block.push(`T2T series ${sv.series}`);
  if (m.isDerivative && sv?.inFnoBan) block.push('F&O ban period');
  if (v?.socialOnly && v.category === 'rumor_social') block.push('unverifiable rumour (social-only)');
  if (block.length) return { final: 'BLOCK', reasons: block };

  // PROTECT — an open position with an adverse, verified cause (or adverse move with no verdict).
  const pos = m.pack.position;
  if (pos && pos.qty !== 0) {
    const adverseDir = (pos.qty > 0 && dir === 'DOWN') || (pos.qty < 0 && dir === 'UP');
    const verifiedCause = !!v && !v.postHoc && (v.bestRank ?? 9) <= 3;
    if (adverseDir && (verifiedCause || m.calibratedConfidence >= 0.6)) {
      return { final: 'PROTECT', reasons: [`open ${pos.qty > 0 ? 'long' : 'short'} faces adverse ${verifiedCause ? 'primary-sourced' : 'high-confidence'} cause`] };
    }
    const moveAdverse = m.anomaly?.ret !== undefined && ((pos.qty > 0 && m.anomaly.ret < 0) || (pos.qty < 0 && m.anomaly.ret > 0));
    if (m.uncertain && moveAdverse && Math.abs(m.anomaly?.z ?? 0) >= 4) {
      return { final: 'PROTECT', reasons: ['open position, large adverse move, cause unresolved'] };
    }
  }

  if (m.uncertain || !v) return { final: 'UNCERTAIN', reasons: [m.uncertain ? 'deep-path self-consistency disagreement or LLM failure' : 'no verdict'] };

  // IGNORE — index/sector-driven.
  if (m.anomaly?.suppressed) return { final: 'IGNORE', reasons: ['move explained by the index (> threshold)'] };
  if (v.category === 'macro_index' || (v.category === 'sector_move' && m.pack.peers.sameDirection >= 3)) {
    return { final: 'IGNORE', reasons: [`${v.category}: not idiosyncratic`] };
  }

  const liquid = m.minuteTurnover === undefined || m.minuteTurnover >= (m.minTurnoverInr ?? 2e5);

  // REACT
  const reactChecks: [boolean, string][] = [
    [v.isNew, 'not new information'],
    [(v.bestRank ?? 9) <= 3, 'no primary / wire source'],
    [!v.postHoc, 'cause published after the move began'],
    [m.calibratedConfidence >= 0.6, `calibrated confidence ${m.calibratedConfidence.toFixed(2)} < 0.60`],
    [dir !== 'NONE', 'no direction'],
    [m.pack.pricedIn.fractionOfTypical === undefined || m.pack.pricedIn.fractionOfTypical < m.cfg.pricedInFraction, `priced in: ${(100 * (m.pack.pricedIn.fractionOfTypical ?? 0)).toFixed(0)}% of typical impact done`],
    [m.pack.pricedIn.minutesSinceFirstPublication === undefined || m.pack.pricedIn.minutesSinceFirstPublication <= m.cfg.maxNewsAgeMin, `news is ${m.pack.pricedIn.minutesSinceFirstPublication} min old (> ${m.cfg.maxNewsAgeMin})`],
    [liquid, 'insufficient liquidity'],
    [!m.nearBand, 'too close to price band'],
  ];
  const reactFails = reactChecks.filter(([ok]) => !ok).map(([, r]) => r);
  const moveDir = Math.sign(m.anomaly?.ret ?? 0);
  if (reactFails.length === 0) {
    if (moveDir !== 0 && ((dir === 'UP' && moveDir < 0) || (dir === 'DOWN' && moveDir > 0))) {
      reasons.push('cause direction contradicts the move; ignoring');
    } else {
      return { final: 'REACT', reasons: ['new primary-sourced material information; drift window open'] };
    }
  }

  // FADE
  const noCause = v.category === 'no_identifiable_cause' || v.citedIds.length === 0;
  const recentFiling = m.pack.sources.some((s) => s.rank <= 2 && Math.abs(s.minutesRelativeToMove) <= 60);
  const rz = Math.abs(m.anomaly?.residualZ ?? 0);
  const z = Math.abs(m.anomaly?.z ?? 0);
  const imb = m.pack.move.imbalance;
  const flowOneSided = imb !== undefined && moveDir !== 0 && Math.sign(imb) === moveDir && Math.abs(imb) > 0.2;
  const fadeChecks: [boolean, string][] = [
    [noCause, 'a cause was identified'],
    [rz >= 3 || (m.anomaly?.residualZ === undefined && z >= 4), 'residual not extreme'],
    [!recentFiling, 'recent filing exists'],
    [!flowOneSided, 'order flow one-sided in the direction of the move'],
    [!m.nearBand, 'too close to price band'],
    [liquid, 'insufficient liquidity'],
  ];
  const fadeFails = fadeChecks.filter(([ok]) => !ok).map(([, r]) => r);
  if (fadeFails.length === 0) return { final: 'FADE', reasons: ['no identifiable cause; extreme residual; reverting flow'] };

  if (v.raw.proposed_verdict === 'REACT') reasons.push(...reactFails.map((r) => `REACT rejected: ${r}`));
  else if (v.raw.proposed_verdict === 'FADE') reasons.push(...fadeFails.map((r) => `FADE rejected: ${r}`));
  else reasons.push('no actionable condition met');
  return { final: 'IGNORE', reasons };
}
