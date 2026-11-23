// HTTP API. Runs on Cloudflare Workers in production (worker.ts) and on Node (node.ts) for
// local development and the Docker image. Configuration comes from c.env on both.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { openDb, type Sql } from './db.js';
import { databaseUrl, type Env } from './env.js';
import { HttpError, notFound } from './lib/http.js';
import { allow } from './lib/ratelimit.js';
import { aiStatus, runTask } from './ai/provider.js';
import { insightsTask } from './ai/tasks.js';
import { canSeeCosts, isAdmin, loadUsers, requireAdmin, requireClient, requireLead, visibleClientIds, type Actor } from './services/access.js';
import { agencyOverview, clientAnalytics } from './services/analytics.js';
import {
  addNote, approveMessage, createLead, draftFollowUp, editDraft, getClient, getLead, leadIdForMessage, listLeads,
  patchLead, qualifyAndRoute, rejectMessage, syncLeadNow, validateNewLead,
} from './services/leads.js';
import { createAgency, deleteAgency, findAgency, pruneAgencies, resolveActor, setGhlMode } from './services/session.js';
import { listAutomations, listRuns, saveAutomation } from './services/automations.js';
import { handleGhlWebhook, signWebhook, simulateInboundReply } from './services/webhooks.js';
import { runDueSyncJobs } from './ghl/sync.js';
import { tickNoReply } from './automations/engine.js';
import { CLIENTS } from './seed/data.js';
import { openapi } from './openapi.js';
import type { GhlMode, Session, Stage } from '../../shared/types.js';

type Vars = { sql: Sql; actor: Actor; ip: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const SANDBOX = 'lf_sandbox';
const VIEWER = 'lf_user';

export const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/api');

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, data: err.data }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
});

// One database client per request, closed after the response.
app.use('*', async (c, next) => {
  const { sql, close } = openDb(databaseUrl(c.env));
  c.set('sql', sql);
  c.set('ip', c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local');
  try {
    await next();
  } finally {
    after(c, close());
  }
  c.header('cache-control', 'no-store');
});

function after(c: C, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p; // Node: no execution context, the promise just runs
  }
}

/** Runs work after the response with its own database client. */
function background(c: C, task: (sql: Sql) => Promise<unknown>) {
  const { sql, close } = openDb(databaseUrl(c.env));
  after(c, task(sql).catch((e) => console.error('[background]', e)).finally(close));
}

const secure = (c: C) => new URL(c.req.url).protocol === 'https:';
const cookieOpts = (c: C) => ({ httpOnly: true, sameSite: 'Lax' as const, secure: secure(c), path: '/', maxAge: 60 * 60 * 24 * 30 });

// ── Public ──────────────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  const t0 = Date.now();
  await c.get('sql')`select 1`;
  return c.json({ ok: true, db_ms: Date.now() - t0, ai: aiStatus(c.env).provider, version: c.env.GIT_SHA ?? 'dev' });
});

app.get('/openapi.json', (c) => c.json(openapi));

// Lead ingestion API, authenticated with a client's API key.
app.post('/v1/leads', async (c) => {
  const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const sql = c.get('sql');
  const [client] = key ? await sql<{ id: string }[]>`select id from clients where api_key = ${key}` : [];
  if (!client) throw new HttpError(401, 'Missing or invalid API key. Send it as: Authorization: Bearer <key>');
  if (!(await allow(sql, `api:${client.id}`, 60, 60))) throw new HttpError(429, 'Rate limit: 60 leads a minute per client.');
  const lead = await createLead(sql, c.env, client.id, validateNewLead(await c.req.json().catch(() => ({}))), 'the API');
  background(c, (s) => qualifyAndRoute(s, c.env, lead.id));
  return c.json({ id: lead.id, status: 'received', qualification: 'pending' }, 201);
});

// Inbound CRM webhook (GoHighLevel-style), signed with HMAC and deduplicated by event id.
app.post('/v1/webhooks/ghl', async (c) => {
  const raw = await c.req.text();
  const result = await handleGhlWebhook(c.get('sql'), c.env, raw, c.req.header('x-leadflow-signature') ?? '');
  if (result.leadId) background(c, (s) => result.followUp!(s));
  return c.json({ ok: true, duplicate: result.duplicate }, result.duplicate ? 200 : 202);
});

// Scheduled worker (GitHub Actions): retries CRM syncs, fires no-reply automations, prunes sandboxes.
app.post('/cron', async (c) => {
  if (!c.env.CRON_SECRET || c.req.header('x-cron-secret') !== c.env.CRON_SECRET) throw new HttpError(403, 'Forbidden');
  const sql = c.get('sql');
  const sync = await runDueSyncJobs(sql, { limit: 20 });
  const noReply = await tickNoReply(sql, c.env, { limit: 20 });
  const pruned = await pruneAgencies(sql);
  return c.json({ sync, no_reply_fired: noReply, pruned });
});

// ── Sandbox session ─────────────────────────────────────────────────────────

const app2 = new Hono<{ Bindings: Env; Variables: Vars }>();

app2.use('*', async (c, next) => {
  const sql = c.get('sql');
  let agency = await findAgency(sql, getCookie(c, SANDBOX));
  if (!agency) {
    agency = await createAgency(sql, c.get('ip'));
    setCookie(c, SANDBOX, agency.id, cookieOpts(c));
    deleteCookie(c, VIEWER, { path: '/' });
  }
  c.set('actor', await resolveActor(sql, agency.id, getCookie(c, VIEWER)));
  await next();
});

async function session(c: C): Promise<Session> {
  const sql = c.get('sql');
  const actor = c.get('actor');
  const ids = await visibleClientIds(sql, actor);
  const [[agency], clients, users] = await Promise.all([
    sql<{ id: string; name: string; ghl_mode: GhlMode }[]>`select id, name, ghl_mode from agencies where id = ${actor.agencyId}::uuid`,
    sql`select id, slug, name, industry, location, brand_color from clients where id = any(${ids}::uuid[]) order by name`,
    loadUsers(sql, actor.agencyId),
  ]);
  return {
    agency,
    user: actor.user,
    users,
    clients: clients as never,
    can: { manage_agency: isAdmin(actor), see_costs: canSeeCosts(actor) },
    ai: aiStatus(c.env),
  };
}

app2.get('/session', async (c) => c.json(await session(c)));

app2.post('/session/viewer', async (c) => {
  const { user_id } = (await c.req.json()) as { user_id: string };
  const users = await loadUsers(c.get('sql'), c.get('actor').agencyId);
  if (!users.some((u) => u.id === user_id)) throw notFound('Unknown person');
  setCookie(c, VIEWER, user_id, cookieOpts(c));
  c.set('actor', { agencyId: c.get('actor').agencyId, user: users.find((u) => u.id === user_id)! });
  return c.json(await session(c));
});

app2.post('/session/reset', async (c) => {
  const sql = c.get('sql');
  await deleteAgency(sql, c.get('actor').agencyId);
  const agency = await createAgency(sql, c.get('ip'));
  setCookie(c, SANDBOX, agency.id, cookieOpts(c));
  deleteCookie(c, VIEWER, { path: '/' });
  c.set('actor', await resolveActor(sql, agency.id, undefined));
  return c.json(await session(c));
});

// ── Agency ──────────────────────────────────────────────────────────────────

app2.get('/overview', async (c) => {
  const sql = c.get('sql');
  const actor = c.get('actor');
  const ids = await visibleClientIds(sql, actor);
  const [clients, attention, [ai]] = await Promise.all([
    agencyOverview(sql, ids),
    sql`
    select l.id, l.first_name, l.last_name, l.company, l.priority, l.score, l.created_at, l.client_id, c.name as client_name,
           l.analysis->>'summary' as summary,
           exists (select 1 from messages m where m.lead_id = l.id and m.status = 'draft') as has_draft
    from leads l join clients c on c.id = l.client_id
    where l.client_id = any(${ids}::uuid[]) and l.stage = 'new' and l.first_response_at is null and l.priority in ('high', 'medium')
    order by l.score desc nulls last, l.created_at limit 8`,
    canSeeCosts(actor)
      ? sql`
          select count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
                 coalesce(avg(ms) filter (where ok), 0)::int as avg_ms
          from ai_usage where agency_id = ${actor.agencyId}::uuid`
      : Promise.resolve([null]),
  ]);
  return c.json({ clients, attention, ai_usage: ai });
});

// ── Clients ─────────────────────────────────────────────────────────────────

app2.get('/clients/:id', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id);
  const sql = c.get('sql');
  const client = await getClient(sql, id, canSeeCosts(c.get('actor')));
  const campaigns = await sql`select id, name, source, utm_campaign, status, started_on, spend from campaigns where client_id = ${id}::uuid order by started_on desc`;
  return c.json({ client, campaigns });
});

app2.get('/clients/:id/leads', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id);
  const q = c.req.query();
  return c.json(await listLeads(c.get('sql'), id, { stage: q.stage, priority: q.priority, source: q.source, campaign: q.campaign, q: q.q, attention: q.attention === '1' }));
});

app2.get('/clients/:id/analytics', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id);
  const days = Math.min(90, Math.max(7, Number(c.req.query('days') ?? 30)));
  return c.json(await clientAnalytics(c.get('sql'), id, days));
});

app2.post('/clients/:id/insights', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  await requireClient(sql, c.get('actor'), id);
  const analytics = await clientAnalytics(sql, id, 30);
  const res = await runTask({ env: c.env, sql, agencyId: c.get('actor').agencyId }, insightsTask(await getClient(sql, id), analytics));
  return c.json({ ...res.data, provider: res.provider, model: res.model, note: res.note ?? null, generated_at: new Date().toISOString() });
});

app2.get('/clients/:id/automations', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id);
  return c.json(await listAutomations(c.get('sql'), id));
});

app2.get('/clients/:id/automation-runs', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id);
  return c.json(await listRuns(c.get('sql'), id));
});

app2.put('/clients/:id/automations/:aid', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id, 'write');
  return c.json(await saveAutomation(c.get('sql'), id, c.req.param('aid'), await c.req.json()));
});

app2.post('/clients/:id/automations', async (c) => {
  const id = c.req.param('id');
  await requireClient(c.get('sql'), c.get('actor'), id, 'write');
  return c.json(await saveAutomation(c.get('sql'), id, null, await c.req.json()), 201);
});

// ── Leads ───────────────────────────────────────────────────────────────────

app2.get('/leads/:id', async (c) => {
  const id = c.req.param('id');
  await requireLead(c.get('sql'), c.get('actor'), id);
  return c.json(await getLead(c.get('sql'), id));
});

app2.patch('/leads/:id', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  await requireLead(sql, c.get('actor'), id, 'write');
  const body = (await c.req.json()) as { stage?: Stage; owner_id?: string | null; value?: number | null; tags?: string[] };
  await patchLead(sql, c.env, id, c.get('actor'), body);
  return c.json(await getLead(sql, id));
});

app2.post('/leads/:id/qualify', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  await requireLead(sql, c.get('actor'), id, 'write');
  const { qualifyLead } = await import('./services/leads.js');
  await qualifyLead(sql, c.env, id);
  return c.json(await getLead(sql, id));
});

app2.post('/leads/:id/draft', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  const actor = c.get('actor');
  await requireLead(sql, actor, id, 'write');
  const body = (await c.req.json().catch(() => ({}))) as { channel?: string; instruction?: string };
  await draftFollowUp(sql, c.env, id, {
    channel: body.channel === 'email' ? 'email' : 'sms',
    instruction: body.instruction?.slice(0, 300),
    createdBy: actor.user.id,
    actorName: actor.user.name,
  });
  return c.json(await getLead(sql, id));
});

app2.post('/leads/:id/notes', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  await requireLead(sql, c.get('actor'), id, 'write');
  await addNote(sql, id, c.get('actor'), ((await c.req.json()) as { body: string }).body ?? '');
  return c.json(await getLead(sql, id));
});

app2.post('/leads/:id/sync', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  const clientId = await requireLead(sql, c.get('actor'), id, 'write');
  await syncLeadNow(sql, id, clientId, c.get('actor').user.name);
  return c.json(await getLead(sql, id));
});

app2.post('/leads/:id/simulate-reply', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  await requireLead(sql, c.get('actor'), id, 'write');
  const body = ((await c.req.json().catch(() => ({}))) as { body?: string }).body;
  const result = await simulateInboundReply(sql, c.env, id, body);
  if (result.followUp) await result.followUp(sql);
  return c.json(await getLead(sql, id));
});

app2.patch('/messages/:id', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  const leadId = await leadIdForMessage(sql, id);
  await requireLead(sql, c.get('actor'), leadId, 'write');
  await editDraft(sql, id, (await c.req.json()) as { body?: string; subject?: string });
  return c.json(await getLead(sql, leadId));
});

app2.post('/messages/:id/approve', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  const leadId = await leadIdForMessage(sql, id);
  await requireLead(sql, c.get('actor'), leadId, 'write');
  await approveMessage(sql, c.env, id, c.get('actor'));
  return c.json(await getLead(sql, leadId));
});

app2.post('/messages/:id/reject', async (c) => {
  const id = c.req.param('id');
  const sql = c.get('sql');
  const leadId = await leadIdForMessage(sql, id);
  await requireLead(sql, c.get('actor'), leadId, 'write');
  await rejectMessage(sql, id, c.get('actor'));
  return c.json(await getLead(sql, leadId));
});

// ── Integrations ────────────────────────────────────────────────────────────

app2.get('/integrations', async (c) => {
  const sql = c.get('sql');
  const actor = c.get('actor');
  const ids = await visibleClientIds(sql, actor);
  const [agency] = await sql`select ghl_mode from agencies where id = ${actor.agencyId}::uuid`;
  const jobs = await sql`
    select j.id, j.lead_id, l.first_name || ' ' || l.last_name as lead_name, c.name as client_name, j.state, j.attempts,
           j.next_attempt_at, j.last_error, j.updated_at,
           coalesce((select json_agg(x order by x.at, x.id) from (
             select at, attempt, step, request, status, outcome, detail, duration_ms, id from sync_attempts where job_id = j.id
           ) x), '[]') as log
    from sync_jobs j join leads l on l.id = j.lead_id join clients c on c.id = j.client_id
    where j.client_id = any(${ids}::uuid[])
    order by j.updated_at desc limit 15`;
  const [counts] = await sql`
    select (select count(*)::int from ghl_contacts where agency_id = ${actor.agencyId}::uuid) as contacts,
           (select count(*)::int from ghl_opportunities where agency_id = ${actor.agencyId}::uuid) as opportunities`;
  return c.json({ ghl_mode: agency.ghl_mode, jobs, crm: counts });
});

app2.put('/integrations/ghl', async (c) => {
  requireAdmin(c.get('actor'));
  const { mode } = (await c.req.json()) as { mode: GhlMode };
  await setGhlMode(c.get('sql'), c.get('actor').agencyId, mode);
  return c.json({ ok: true });
});

app2.post('/integrations/run', async (c) => {
  const sql = c.get('sql');
  const sync = await runDueSyncJobs(sql, { agencyId: c.get('actor').agencyId, limit: 10, budgetMs: 4000 });
  const noReply = await tickNoReply(sql, c.env, { agencyId: c.get('actor').agencyId, limit: 5 });
  return c.json({ sync, no_reply_fired: noReply });
});

app2.get('/integrations/ghl/opportunities', async (c) => {
  const rows = await c.get('sql')`
    select o.id, o.name, o.stage_id, o.status, o.monetary_value, o.updated_at, ct.email, ct.phone
    from ghl_opportunities o join ghl_contacts ct on ct.id = o.contact_id
    where o.agency_id = ${c.get('actor').agencyId}::uuid order by o.updated_at desc limit 100`;
  return c.json(rows);
});

// ── Public lead form (in the visitor's sandbox) ────────────────────────────

app2.get('/forms/:slug', async (c) => {
  const def = CLIENTS.find((x) => x.slug === c.req.param('slug'));
  if (!def) throw notFound('Form not found');
  const sql = c.get('sql');
  const [client] = await sql`select id, name, brand_color, location from clients where agency_id = ${c.get('actor').agencyId}::uuid and slug = ${def.slug}`;
  const campaigns = await sql`select name, source, utm_campaign from campaigns where client_id = ${client.id}::uuid and status = 'active' order by name`;
  return c.json({ client, form: def.form, campaigns });
});

app2.post('/forms/:slug', async (c) => {
  const sql = c.get('sql');
  if (!(await allow(sql, `form:${c.get('ip')}`, 3600, 30))) throw new HttpError(429, 'Too many submissions from this network. Try again later.');
  const [client] = await sql<{ id: string }[]>`select id from clients where agency_id = ${c.get('actor').agencyId}::uuid and slug = ${c.req.param('slug')}`;
  if (!client) throw notFound('Form not found');
  const lead = await createLead(sql, c.env, client.id, validateNewLead(await c.req.json()), 'the website form');
  background(c, (s) => qualifyAndRoute(s, c.env, lead.id));
  return c.json({ id: lead.id, client_id: client.id }, 201);
});

app2.get('/webhooks/sign', async (c) => {
  // Lets the API docs page show a correctly signed example for this sandbox.
  const body = JSON.stringify({ type: 'InboundMessage', webhookId: 'evt_example', locationId: 'loc_example', contactId: 'abc', body: 'Yes, Thursday works' });
  return c.json({ body, signature: await signWebhook(c.env, body) });
});

app.route('/', app2);
