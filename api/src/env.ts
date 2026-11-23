// Configuration arrives as Worker bindings in production and from process.env on Node.
// Either way the app reads it from c.env, so the same code runs on both.
export interface Env {
  DATABASE_URL: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  /** AI calls allowed per day across all visitors before falling back to demo mode. */
  DAILY_AI_LIMIT?: string;
  CRON_SECRET?: string;
  /** Shared secret for signing simulated inbound CRM webhooks. */
  WEBHOOK_SECRET?: string;
  GIT_SHA?: string;
  /** Cloudflare Hyperdrive in front of Neon (Workers only). Preferred over DATABASE_URL when present. */
  HYPERDRIVE?: { connectionString: string };
  /** Static assets binding on Cloudflare Workers. */
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export const databaseUrl = (env: Env) => env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;

export function envFromProcess(): Env {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
    CRON_SECRET: process.env.CRON_SECRET,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    GIT_SHA: process.env.GIT_SHA,
  };
}
