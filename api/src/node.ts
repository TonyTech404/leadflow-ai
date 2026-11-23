// Node entry, for local development and the Docker image. Serves the API and, when built,
// the web app from web/dist (single-page app fallback to index.html).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { app } from './app.js';
import { envFromProcess } from './env.js';

const env = envFromProcess();
const root = process.env.STATIC_DIR ?? '../web/dist';
const server = new Hono();
server.all('/api/*', (c) => app.fetch(c.req.raw, env));
if (existsSync(root)) {
  server.use('/*', serveStatic({ root }));
  server.get('*', serveStatic({ root, path: 'index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: server.fetch, port }, (info) => console.log(`LeadFlow AI on http://localhost:${info.port}`));
