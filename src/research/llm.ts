// OpenAI (ChatGPT models) wrapper for the research agent.
//  - Responses API + Structured Outputs (Zod schema, strict): the model can only
//    return the verdict schema; a parse failure is an error, never a guess.
//  - Reasoning effort per call (cheap `low` for triage, `medium` for judging).
//  - Prompt caching: static instructions first, a stable `prompt_cache_key` per
//    purpose; cached input bills at ~10% of the input rate.
//  - Hard timeout (no SDK retries inside the latency budget), daily call budget,
//    per-model usage/cost accounting (incl. cached and reasoning tokens).
// The LLM never sizes or places trades: its output is a label that deterministic
// code verifies and maps to an allowed action.

import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import type { Db } from '../db/database.ts';
import { istDate } from '../core/clock.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('llm');

/** USD per 1M tokens: [input, cached input, output]. OpenAI price list, Sep 2026. */
const PRICING: Record<string, [number, number, number]> = {
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-6-sol': [2, 0.2, 10],
  'gpt-6-astra': [10, 1, 50],
};

export function estimateCostUsd(model: string, inTok: number, cachedTok: number, outTok: number): number {
  const p = PRICING[model] ?? PRICING['gpt-6-sol'];
  const fresh = Math.max(0, inTok - cachedTok);
  return (fresh * p[0] + cachedTok * p[1] + outTok * p[2]) / 1e6;
}

export class LlmBudgetError extends Error {}
export class LlmRefusalError extends Error {}

export type Effort = 'none' | 'low' | 'medium' | 'high';

export interface StructuredCallOpts<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Short name for the output schema (required by structured outputs). */
  schemaName: string;
  timeoutMs: number;
  maxTokens?: number;
  effort?: Effort;
  purpose: string;
}

export interface StructuredResult<T> {
  value: T;
  model: string;
  latencyMs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmClient {
  available(): boolean;
  call<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>>;
  usageToday(): { calls: number; costUsd: number; errors: number; byModel: Record<string, { calls: number; costUsd: number; p95Ms?: number }> };
}

export class OpenAiLlm implements LlmClient {
  private client?: OpenAI;
  private db: Db;
  private maxCallsPerDay: number;
  private latencies = new Map<string, number[]>();

  constructor(db: Db, apiKey: string | undefined, maxCallsPerDay: number) {
    this.db = db;
    this.maxCallsPerDay = maxCallsPerDay;
    if (apiKey) this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  available(): boolean {
    return !!this.client;
  }

  async call<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
    if (!this.client) throw new Error('OPENAI_API_KEY not configured');
    const day = istDate(Date.now());
    const used = this.db.get<{ n: number }>('SELECT COALESCE(SUM(calls),0) AS n FROM llm_usage WHERE day = ?', day)?.n ?? 0;
    if (used >= this.maxCallsPerDay) throw new LlmBudgetError(`daily LLM call budget exhausted (${used}/${this.maxCallsPerDay})`);

    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        this.client.responses.parse(
          {
            model: o.model,
            // Static instructions first → stable, cacheable prefix.
            instructions: o.system,
            input: o.user,
            text: { format: zodTextFormat(o.schema, o.schemaName) },
            reasoning: { effort: o.effort ?? 'low' },
            max_output_tokens: o.maxTokens ?? 4000,
            prompt_cache_key: `tradeai-${o.purpose.split('.')[0]}`,
            store: false,
          },
          { timeout: o.timeoutMs, maxRetries: 0 },
        ),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`LLM timeout after ${o.timeoutMs}ms (${o.purpose})`)), o.timeoutMs + 250);
        }),
      ]);
      const latency = Date.now() - t0;
      const inTok = res.usage?.input_tokens ?? 0;
      const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
      const outTok = res.usage?.output_tokens ?? 0; // includes reasoning tokens
      const cost = estimateCostUsd(o.model, inTok, cached, outTok);
      this.record(day, o.model, inTok, outTok, cost, latency, false);
      const refused = res.output?.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'));
      if (refused) throw new LlmRefusalError(`model refused (${o.purpose})`);
      if (res.status === 'incomplete') throw new Error(`LLM output incomplete: ${res.incomplete_details?.reason ?? 'unknown'} (${o.purpose})`);
      const parsed = res.output_parsed as T | null;
      if (parsed === null || parsed === undefined) throw new Error(`LLM returned no parseable output (${o.purpose})`);
      return { value: parsed, model: res.model ?? o.model, latencyMs: latency, inputTokens: inTok, cachedTokens: cached, outputTokens: outTok, costUsd: cost };
    } catch (e) {
      if (!(e instanceof LlmRefusalError) && !(e instanceof LlmBudgetError)) this.record(day, o.model, 0, 0, 0, Date.now() - t0, true);
      if (e instanceof OpenAI.RateLimitError) log.warn('LLM rate limited', { purpose: o.purpose });
      else if (e instanceof OpenAI.APIConnectionError) log.warn('LLM connection error', { purpose: o.purpose });
      else if (e instanceof OpenAI.APIError) log.error('LLM API error', { status: e.status, purpose: o.purpose, msg: e.message });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private record(day: string, model: string, inTok: number, outTok: number, cost: number, latency: number, error: boolean): void {
    let l = this.latencies.get(model);
    if (!l) this.latencies.set(model, (l = []));
    l.push(latency);
    if (l.length > 500) l.shift();
    const sorted = [...l].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    this.db.run(
      `INSERT INTO llm_usage (day, model, calls, input_tokens, output_tokens, cost_usd, errors, p95_ms) VALUES (?,?,1,?,?,?,?,?)
       ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd, errors = errors + excluded.errors, p95_ms = excluded.p95_ms`,
      day, model, inTok, outTok, cost, error ? 1 : 0, p95,
    );
  }

  usageToday(): ReturnType<LlmClient['usageToday']> {
    const rows = this.db.all<{ model: string; calls: number; cost_usd: number; errors: number; p95_ms: number | null }>('SELECT * FROM llm_usage WHERE day = ?', istDate(Date.now()));
    const byModel: Record<string, { calls: number; costUsd: number; p95Ms?: number }> = {};
    let calls = 0;
    let cost = 0;
    let errors = 0;
    for (const r of rows) {
      byModel[r.model] = { calls: r.calls, costUsd: r.cost_usd, p95Ms: r.p95_ms ?? undefined };
      calls += r.calls;
      cost += r.cost_usd;
      errors += r.errors;
    }
    return { calls, costUsd: cost, errors, byModel };
  }
}
