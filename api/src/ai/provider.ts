// LLM provider abstraction.
//
// Every AI feature is a typed task: a prompt, a Zod schema for the answer, and a rule-based
// fallback. runTask() picks the provider:
//   - "anthropic": Claude through the official SDK, with structured outputs (messages.parse),
//     so the answer is validated against the schema before the app sees it.
//   - "demo": the task's own rules. Used when no API key is configured, when a sandbox or the day
//     has used its AI allowance, or when the call fails. The result says so, and the UI labels it;
//     a demo answer is never presented as an AI call.
// Adding another vendor means one more implementation of callModel().
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Sql } from '../db.js';
import { DEFAULT_MODEL, type Env } from '../env.js';
import { allow } from '../lib/ratelimit.js';

export interface AiTask<T> {
  name: 'qualify' | 'draft' | 'insights';
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Deterministic answer for demo mode. */
  demo: () => T;
}

export interface AiResult<T> {
  data: T;
  provider: 'anthropic' | 'demo';
  model: string;
  ms: number;
  /** Why demo mode was used, when it was. */
  note?: string;
}

export interface AiContext {
  env: Env;
  sql: Sql;
  agencyId: string | null;
}

/** Per sandbox per hour, and per day across everyone: keeps a public demo's bill predictable. */
const SANDBOX_HOURLY_LIMIT = 60;

export function aiStatus(env: Env) {
  const live = !!env.ANTHROPIC_API_KEY;
  return { provider: live ? ('anthropic' as const) : ('demo' as const), model: live ? env.AI_MODEL || DEFAULT_MODEL : 'rules-v1', live };
}

export async function runTask<T>(ctx: AiContext, task: AiTask<T>): Promise<AiResult<T>> {
  const demo = (note: string): AiResult<T> => ({ data: task.demo(), provider: 'demo', model: 'rules-v1', ms: 0, note });

  if (!ctx.env.ANTHROPIC_API_KEY) return demo('No AI provider is configured, so this is a rule-based demo result.');
  if (ctx.sql && ctx.agencyId && !(await allow(ctx.sql, `ai:${ctx.agencyId}`, 3600, SANDBOX_HOURLY_LIMIT))) {
    return demo('This demo sandbox has used its hourly AI allowance, so this is a rule-based result.');
  }
  if (ctx.sql && !(await allow(ctx.sql, 'ai:daily', 86400, Number(ctx.env.DAILY_AI_LIMIT ?? 2000)))) {
    return demo("The demo has used today's AI allowance, so this is a rule-based result.");
  }

  const model = ctx.env.AI_MODEL || DEFAULT_MODEL;
  const started = Date.now();
  try {
    const { data, inputTokens, outputTokens } = await callAnthropic(ctx.env.ANTHROPIC_API_KEY, model, task);
    const ms = Date.now() - started;
    await logUsage(ctx, task.name, 'anthropic', model, inputTokens, outputTokens, ms, true);
    return { data, provider: 'anthropic', model, ms };
  } catch (err) {
    const ms = Date.now() - started;
    await logUsage(ctx, task.name, 'anthropic', model, 0, 0, ms, false);
    console.error(`[ai] ${task.name} failed:`, err);
    return demo('The AI call failed, so this is a rule-based result. Try again in a moment.');
  }
}

async function callAnthropic<T>(apiKey: string, model: string, task: AiTask<T>) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 25_000 });
  const response = await client.messages.parse({
    model,
    max_tokens: task.maxTokens,
    system: task.system,
    messages: [{ role: 'user', content: task.prompt }],
    // Low effort: these are short classification and writing tasks, not open-ended reasoning.
    output_config: { effort: 'low', format: zodOutputFormat(task.schema) },
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off (max_tokens).');
  if (!response.parsed_output) throw new Error('The answer did not match the schema.');
  return {
    data: response.parsed_output as T,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function logUsage(ctx: AiContext, task: string, provider: string, model: string, input: number, output: number, ms: number, ok: boolean) {
  try {
    await ctx.sql`insert into ai_usage (agency_id, task, provider, model, input_tokens, output_tokens, ms, ok)
                  values (${ctx.agencyId}::uuid, ${task}, ${provider}, ${model}, ${input}, ${output}, ${ms}, ${ok})`;
  } catch {
    // Usage logging must never break the feature.
  }
}
