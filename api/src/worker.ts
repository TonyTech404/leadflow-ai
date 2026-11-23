// Cloudflare Workers entry: /api/* goes to the Hono app, everything else to the static web app.
import { app } from './app.js';
import type { Env } from './env.js';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(req, env, ctx);
    return env.ASSETS!.fetch(req);
  },
} satisfies ExportedHandler<Env>;
