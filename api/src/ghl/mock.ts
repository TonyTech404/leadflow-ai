// A stand-in for GoHighLevel's API (LeadConnector v2), backed by the ghl_* tables.
//
// It follows the documented shapes closely enough that ./client.ts would work against
// https://services.leadconnectorhq.com with `fetch` as its transport:
//   - Authorization: Bearer <access token> and a required `Version: 2021-07-28` header
//   - POST /oauth/token to refresh an expired access token
//   - POST /contacts/upsert (deduplicates on email or phone, returns { new, contact })
//   - POST /opportunities/, PUT /opportunities/:id, GET /opportunities/search
//   - errors as { statusCode, message }
// The sandbox's "GoHighLevel connection" setting decides how it misbehaves. This is a
// simulation; it is labelled as one everywhere it appears in the app.
import { Hono } from 'hono';
import type { Sql } from '../db.js';
import { ghlId } from '../lib/ids.js';
import type { GhlMode } from '../../../shared/types.js';

export const GHL_BASE = 'https://services.leadconnectorhq.com';
export const GHL_VERSION = '2021-07-28';
/** Set on a response whose request was applied but whose reply the transport should "lose". */
export const DROP_HEADER = 'x-mock-drop-response';

type Env = { Bindings: { sql: Sql }; Variables: { agencyId: string; mode: GhlMode } };

const err = (statusCode: number, message: string) => ({ statusCode, message });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ghlMock = new Hono<Env>();

// Token refresh. Real GHL takes form-encoded client credentials and a refresh token.
ghlMock.post('/oauth/token', async (c) => {
  const form = await c.req.parseBody();
  if (form.grant_type !== 'refresh_token' || typeof form.refresh_token !== 'string') {
    return c.json({ error: 'invalid_grant', error_description: 'refresh_token is required' }, 400);
  }
  const agencyId = form.refresh_token.replace(/^demo-refresh-/, '');
  const [a] = await c.env.sql<{ ghl_token_version: number }[]>`select ghl_token_version from agencies where id = ${agencyId}::uuid`;
  if (!a) return c.json({ error: 'invalid_grant' }, 400);
  await sleep(150);
  return c.json({
    access_token: `demo-${agencyId}-v${a.ghl_token_version}`,
    token_type: 'Bearer',
    expires_in: 86399,
    refresh_token: form.refresh_token,
    scope: 'contacts.write opportunities.write',
  });
});

// Auth, version header, latency, and the failure modes.
ghlMock.use('*', async (c, next) => {
  if (c.req.path === '/oauth/token') return next();
  if (c.req.header('version') !== GHL_VERSION) return c.json(err(400, 'Version header is required'), 400);
  const token = c.req.header('authorization')?.match(/^Bearer demo-([0-9a-f-]{36})-v(\d+)$/i);
  if (!token) return c.json(err(401, 'Invalid JWT'), 401);
  const [a] = await c.env.sql<{ ghl_mode: GhlMode; ghl_token_version: number }[]>`
    select ghl_mode, ghl_token_version from agencies where id = ${token[1]}::uuid`;
  if (!a) return c.json(err(401, 'Invalid JWT'), 401);
  if (Number(token[2]) !== a.ghl_token_version) return c.json(err(401, 'Invalid JWT: token expired'), 401);

  await sleep(120 + Math.random() * 200);
  if (a.ghl_mode === 'rate_limited' && Math.random() < 0.45) {
    return c.json(err(429, 'Too Many Requests: burst limit of 100 requests per 10 seconds reached'), 429, { 'Retry-After': '1' });
  }
  if (a.ghl_mode === 'outage' && Math.random() < 0.4) {
    return c.json(err(503, 'Service Unavailable'), 503);
  }
  c.set('agencyId', token[1]);
  c.set('mode', a.ghl_mode);
  await next();
});

interface ContactRow {
  id: string;
  location_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  tags: string[];
  custom_fields: unknown[];
  created_at: string;
  updated_at: string;
}

const contactJson = (r: ContactRow) => ({
  id: r.id,
  locationId: r.location_id,
  firstName: r.first_name,
  lastName: r.last_name,
  email: r.email,
  phone: r.phone,
  source: r.source,
  tags: r.tags,
  customFields: r.custom_fields,
  dateAdded: r.created_at,
  dateUpdated: r.updated_at,
});

ghlMock.post('/contacts/upsert', async (c) => {
  const b = (await c.req.json()) as {
    locationId?: string; firstName?: string; lastName?: string; email?: string; phone?: string;
    source?: string; tags?: string[]; customFields?: unknown[];
  };
  if (!b.locationId) return c.json(err(422, 'locationId is required'), 422);
  if (!b.email && !b.phone) return c.json(err(422, 'email or phone is required'), 422);
  const sql = c.env.sql;
  const [existing] = await sql<ContactRow[]>`
    select * from ghl_contacts
    where agency_id = ${c.get('agencyId')}::uuid and location_id = ${b.locationId}
      and ((${b.email ?? null}::text is not null and lower(email) = lower(${b.email ?? null}))
        or (${b.phone ?? null}::text is not null and phone = ${b.phone ?? null}))
    limit 1`;
  if (existing) {
    const [row] = await sql<ContactRow[]>`
      update ghl_contacts set
        first_name = coalesce(${b.firstName ?? null}, first_name), last_name = coalesce(${b.lastName ?? null}, last_name),
        email = coalesce(${b.email ?? null}, email), phone = coalesce(${b.phone ?? null}, phone),
        tags = (select array(select distinct unnest(tags || ${b.tags ?? []}::text[]))),
        custom_fields = ${sql.json((b.customFields ?? existing.custom_fields) as never)}, updated_at = now()
      where id = ${existing.id} returning *`;
    return c.json({ new: false, contact: contactJson(row), traceId: crypto.randomUUID() });
  }
  const [row] = await sql<ContactRow[]>`
    insert into ghl_contacts (id, agency_id, location_id, first_name, last_name, email, phone, source, tags, custom_fields)
    values (${ghlId()}, ${c.get('agencyId')}::uuid, ${b.locationId}, ${b.firstName ?? null}, ${b.lastName ?? null},
            ${b.email ?? null}, ${b.phone ?? null}, ${b.source ?? null}, ${b.tags ?? []}::text[], ${sql.json((b.customFields ?? []) as never)})
    returning *`;
  return c.json({ new: true, contact: contactJson(row), traceId: crypto.randomUUID() }, 201);
});

interface OppRow {
  id: string;
  location_id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  name: string;
  status: string;
  monetary_value: number | null;
  created_at: string;
  updated_at: string;
}

const oppJson = (r: OppRow) => ({
  id: r.id,
  name: r.name,
  locationId: r.location_id,
  contactId: r.contact_id,
  pipelineId: r.pipeline_id,
  pipelineStageId: r.stage_id,
  status: r.status,
  monetaryValue: r.monetary_value,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

ghlMock.get('/opportunities/search', async (c) => {
  const locationId = c.req.query('location_id');
  const contactId = c.req.query('contact_id');
  if (!locationId) return c.json(err(422, 'location_id is required'), 422);
  const rows = await c.env.sql<OppRow[]>`
    select * from ghl_opportunities
    where agency_id = ${c.get('agencyId')}::uuid and location_id = ${locationId}
      and (${contactId ?? null}::text is null or contact_id = ${contactId ?? null})
    order by created_at`;
  return c.json({ opportunities: rows.map(oppJson), meta: { total: rows.length } });
});

ghlMock.post('/opportunities/', async (c) => {
  const b = (await c.req.json()) as {
    locationId?: string; contactId?: string; pipelineId?: string; pipelineStageId?: string;
    name?: string; status?: string; monetaryValue?: number;
  };
  if (!b.locationId || !b.contactId || !b.pipelineId || !b.name) return c.json(err(422, 'locationId, contactId, pipelineId and name are required'), 422);
  const sql = c.env.sql;
  const [contact] = await sql`select id from ghl_contacts where id = ${b.contactId} and agency_id = ${c.get('agencyId')}::uuid`;
  if (!contact) return c.json(err(422, 'contactId not found'), 422);
  const [row] = await sql<OppRow[]>`
    insert into ghl_opportunities (id, agency_id, location_id, contact_id, pipeline_id, stage_id, name, status, monetary_value)
    values (${ghlId()}, ${c.get('agencyId')}::uuid, ${b.locationId}, ${b.contactId}, ${b.pipelineId},
            ${b.pipelineStageId ?? 'new'}, ${b.name}, ${b.status ?? 'open'}, ${b.monetaryValue ?? null})
    returning *`;
  const headers: Record<string, string> = {};
  // Outage mode: sometimes the opportunity is saved and then the connection drops.
  if (c.get('mode') === 'outage' && Math.random() < 0.5) headers[DROP_HEADER] = '1';
  return c.json({ opportunity: oppJson(row), traceId: crypto.randomUUID() }, 201, headers);
});

ghlMock.put('/opportunities/:id', async (c) => {
  const b = (await c.req.json()) as { pipelineStageId?: string; status?: string; monetaryValue?: number; name?: string };
  const [row] = await c.env.sql<OppRow[]>`
    update ghl_opportunities set
      stage_id = coalesce(${b.pipelineStageId ?? null}, stage_id), status = coalesce(${b.status ?? null}, status),
      monetary_value = coalesce(${b.monetaryValue ?? null}::numeric, monetary_value), name = coalesce(${b.name ?? null}, name),
      updated_at = now()
    where id = ${c.req.param('id')} and agency_id = ${c.get('agencyId')}::uuid
    returning *`;
  if (!row) return c.json(err(404, 'Opportunity not found'), 404);
  return c.json({ opportunity: oppJson(row), traceId: crypto.randomUUID() });
});
