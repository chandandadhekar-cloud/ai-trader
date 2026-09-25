// Regression eval for the research agent (plan §D "LLM evaluation"): run on every
// prompt or model change. Scores direction/category/verdict accuracy, citation
// validity (target > 95%), Brier score of stated confidence, and p95 latency.
//   npm run eval:research                  (fast model)
//   npm run eval:research -- --deep        (deep path)
//   npm run eval:research -- --deterministic
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Db } from '../../db/database.ts';
import { loadSettings } from '../../config/settings.ts';
import { AnthropicLlm } from '../llm.ts';
import { runDeep, runDeterministic, runFast } from '../agents.ts';
import { verifyVerdict, citationValidity } from '../verify.ts';
import { mapVerdict } from '../verdictMapper.ts';
import { ResearchConfigSchema } from '../../config/runtime.ts';
import { SOURCE_RANK } from '../sources.ts';
import { lexiconScore } from '../localNlp.ts';
import { PROMPT_VERSION } from '../prompts.ts';
import type { FactPack } from '../factPack.ts';

process.env.NODE_ENV = 'test';
const { values } = parseArgs({ options: { deep: { type: 'boolean' }, deterministic: { type: 'boolean' }, file: { type: 'string' } } });
const file = values.file ?? fileURLToPath(new URL('./golden.json', import.meta.url));
const golden = JSON.parse(readFileSync(file, 'utf8')) as { cases: any[] };
const s = loadSettings();
const llm = new AnthropicLlm(new Db(':memory:'), s.ANTHROPIC_API_KEY, 10_000);
const useLlm = !values.deterministic && llm.available();
if (!values.deterministic && !llm.available()) process.stdout.write('ANTHROPIC_API_KEY not set → running the deterministic fallback.\n');

const now = Date.now();
const rows: { id: string; dir: boolean; cat: boolean; verdict: boolean; cite: number; conf: number; latency: number; final: string }[] = [];
for (const c of golden.cases) {
  const moveStart = now - 5 * 60_000;
  const pack: FactPack = {
    id: c.id, symbol: c.symbol, key: `NSE_EQ|${c.symbol}`, builtAt: now, buildMs: 0,
    move: { detectedTs: now, moveStartTs: moveStart, price: 100, retSinceStart: c.moveRet, residualZ: c.residualZ, z: c.residualZ, explainedByIndex: c.explainedByIndex },
    sources: c.sources.map((x: any) => ({ id: x.id, kind: x.kind, rank: SOURCE_RANK[x.kind as keyof typeof SOURCE_RANK], source: x.kind, title: x.title, publishedTs: moveStart + x.minutesRelativeToMove * 60_000, receivedTs: now, minutesRelativeToMove: x.minutesRelativeToMove, lexicon: lexiconScore(x.title).score })),
    deals: [], surveillance: null, peers: { total: 5, sameDirection: c.explainedByIndex > 0.7 ? 4 : 0, symbols: [] }, globalCues: {},
    pricedIn: { fractionOfTypical: 0.3, minutesSinceFirstPublication: 6 }, sourceErrors: [], sourceHash: c.id,
  };
  const run = !useLlm ? runDeterministic(pack) : values.deep ? await runDeep(llm, pack, s.LLM_DEEP_MODEL, s.LLM_DEEP_TIMEOUT_MS) : await runFast(llm, pack, s.LLM_FAST_MODEL, s.LLM_FAST_TIMEOUT_MS);
  const v = run.verdict;
  const verified = v ? verifyVerdict(v, pack) : undefined;
  const anomaly = { id: c.id, key: pack.key, symbol: c.symbol, type: 'RETURN_SHOCK' as const, ts: now, severity: 80, price: 100, tier: 'A' as const, details: {}, ret: c.moveRet, z: c.residualZ, residualZ: c.residualZ, suppressed: c.explainedByIndex > 0.7 };
  const final = mapVerdict({ verified, uncertain: run.uncertain || !verified, pack, anomaly, calibratedConfidence: verified?.confidence ?? 0, isDerivative: false, nearBand: false, bandLocked: false, cfg: ResearchConfigSchema.parse({}) }).final;
  rows.push({
    id: c.id,
    dir: v?.direction === c.expect.direction,
    cat: !!v && c.expect.category.includes(verified!.category),
    verdict: c.expect.verdict.includes(final),
    cite: v ? citationValidity(v, pack) : 0,
    conf: verified?.confidence ?? 0,
    latency: run.latencyMs,
    final,
  });
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const brier = mean(rows.map((r) => (r.conf - (r.dir && r.cat ? 1 : 0)) ** 2));
const lat = rows.map((r) => r.latency).sort((a, b) => a - b);
console.table(rows);
process.stdout.write(`\nprompt ${PROMPT_VERSION} | path ${!useLlm ? 'deterministic' : values.deep ? `deep ${s.LLM_DEEP_MODEL}` : `fast ${s.LLM_FAST_MODEL}`}\n`);
process.stdout.write(`direction ${(100 * mean(rows.map((r) => +r.dir))).toFixed(0)}% | category ${(100 * mean(rows.map((r) => +r.cat))).toFixed(0)}% | final verdict ${(100 * mean(rows.map((r) => +r.verdict))).toFixed(0)}% | citation validity ${(100 * mean(rows.map((r) => r.cite))).toFixed(1)}% | Brier ${brier.toFixed(3)} | p95 latency ${lat[Math.floor(lat.length * 0.95)] ?? 0} ms\n`);
