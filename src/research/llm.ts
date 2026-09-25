// Claude API wrapper for the research agent.
//  - Structured outputs (output_config.format from a Zod schema) so the model can
//    only return the verdict schema; parsing failures are errors, never guesses.
//  - Hard timeout (no SDK retries inside the latency budget).
//  - Daily call budget and per-model usage/cost accounting (plan §C cost control).
//  - Server-side refusal fallbacks enabled for Opus-tier deep calls.
// The LLM never sizes or places trades: its output is a label that deterministic
// code verifies and maps to an allowed action.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Db } from '../db/database.ts';
import { istDate } from '../core/clock.ts';
import { createLogger } from '../core/logger.ts';

const log = createLogger('llm');

/** USD per million tokens (input, output). Keep in sync with Anthropic pricing. */
const PRICING: Record<string, [number, number]> = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [2, 10],
  'claude-opus-5': [5, 25],
  'claude-opus-5-5': [4, 20],
  'claude-fable-5-1': [10, 50],
};

export function estimateCostUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] ?? [5, 25];
  return (inTok * p[0] + outTok * p[1]) / 1e6;
}

export class LlmBudgetError extends Error {}
export class LlmRefusalError extends Error {}

export interface StructuredCallOpts<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  purpose: string;
}

export interface StructuredResult<T> {
  value: T;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmClient {
  available(): boolean;
  call<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>>;
  usageToday(): { calls: number; costUsd: number; errors: number; byModel: Record<string, { calls: number; costUsd: number; p95Ms?: number }> };
}

export class AnthropicLlm implements LlmClient {
  private client?: Anthropic;
  private db: Db;
  private maxCallsPerDay: number;
  private latencies = new Map<string, number[]>();

  constructor(db: Db, apiKey: string | undefined, maxCallsPerDay: number) {
    this.db = db;
    this.maxCallsPerDay = maxCallsPerDay;
    if (apiKey) this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  available(): boolean {
    return !!this.client;
  }

  private supportsEffort(model: string): boolean {
    return !model.startsWith('claude-haiku');
  }

  private supportsFallbacks(model: string): boolean {
    return model === 'claude-opus-5' || model.startsWith('claude-fable-5');
  }

  async call<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
    if (!this.client) throw new Error('ANTHROPIC_API_KEY not configured');
    const day = istDate(Date.now());
    const used = this.db.get<{ n: number }>('SELECT COALESCE(SUM(calls),0) AS n FROM llm_usage WHERE day = ?', day)?.n ?? 0;
    if (used >= this.maxCallsPerDay) throw new LlmBudgetError(`daily LLM call budget exhausted (${used}/${this.maxCallsPerDay})`);

    const t0 = Date.now();
    const params = {
      model: o.model,
      max_tokens: o.maxTokens ?? 2048,
      system: o.system,
      messages: [{ role: 'user' as const, content: o.user }],
      output_config: {
        format: zodOutputFormat(o.schema),
        ...(o.effort && this.supportsEffort(o.model) ? { effort: o.effort } : {}),
      },
      ...(this.supportsFallbacks(o.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        this.client.beta.messages.parse(params, { timeout: o.timeoutMs, maxRetries: 0 }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`LLM timeout after ${o.timeoutMs}ms (${o.purpose})`)), o.timeoutMs + 250);
        }),
      ]);
      const latency = Date.now() - t0;
      const inTok = res.usage?.input_tokens ?? 0;
      const outTok = res.usage?.output_tokens ?? 0;
      const cost = estimateCostUsd(o.model, inTok, outTok);
      this.record(day, o.model, inTok, outTok, cost, latency, false);
      if (res.stop_reason === 'refusal') throw new LlmRefusalError(`model declined (${o.purpose})`);
      if (res.stop_reason === 'max_tokens') throw new Error(`LLM output truncated at max_tokens (${o.purpose})`);
      const parsed = res.parsed_output as T | null | undefined;
      if (parsed === null || parsed === undefined) throw new Error(`LLM returned no parseable output (${o.purpose})`);
      return { value: parsed, model: res.model ?? o.model, latencyMs: latency, inputTokens: inTok, outputTokens: outTok, costUsd: cost };
    } catch (e) {
      if (!(e instanceof LlmRefusalError)) this.record(day, o.model, 0, 0, 0, Date.now() - t0, true);
      if (e instanceof Anthropic.RateLimitError) log.warn('LLM rate limited', { purpose: o.purpose });
      else if (e instanceof Anthropic.APIConnectionError) log.warn('LLM connection error', { purpose: o.purpose });
      else if (e instanceof Anthropic.APIError) log.error('LLM API error', { status: e.status, purpose: o.purpose, msg: e.message });
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
