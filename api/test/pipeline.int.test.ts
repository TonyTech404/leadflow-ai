// Integration tests against Postgres (CI uses a dedicated Neon branch). They run without an AI key,
// so qualification uses the deterministic demo rules and the results are repeatable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = !!process.env.DATABASE_URL;
process.env.GHL_TIMEOUT_MS = '4000';

describe.skipIf(!enabled)('lead pipeline against Postgres', () => {
  let m: typeof import('./modules.js');
  let sql: import('../src/db.js').Sql;
  let agency: { id: string };
  let clients: Record<string, string>;
  const env = { DATABASE_URL: process.env.DATABASE_URL! };

  beforeAll(async () => {
    m = await import('./modules.js');
    sql = m.openDb(env.DATABASE_URL).sql;
    agency = await m.createAgency(sql, `test-${Date.now()}`);
    const rows = await sql<{ id: string; slug: string }[]>`select id, slug from clients where agency_id = ${agency.id}::uuid`;
    clients = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  }, 120_000);

  afterAll(async () => {
    if (agency) await m.deleteAgency(sql, agency.id);
    await m.closeShared();
  });

  const newLead = async (over: Record<string, unknown> = {}) => {
    const lead = await m.createLead(sql, env, clients['brightside-solar'], m.validateNewLead({
      first_name: 'Olivia', last_name: `Test${Math.random().toString(36).slice(2, 7)}`, phone: `07700 9009${Math.floor(Math.random() * 90 + 10)}`,
      email: `olivia.${Date.now()}@example.com`, postcode: 'M20 4RF', utm_campaign: 'winter-energy-bills',
      answers: { Homeowner: 'Yes', Timeline: 'As soon as possible' },
      message: 'We want solar and a battery as soon as possible; we both work from home and bills are huge.',
      ...over,
    }), 'a test');
    return lead;
  };

  it('captures, qualifies, runs automations and syncs to the CRM', async () => {
    const lead = await newLead();
    await lead.process();
    const l = await m.getLead(sql, lead.id);
    expect(l.analysis?.provider).toBe('demo');
    expect(l.priority).toBe('high');
    expect(l.owner_name).toBe('Priya Shah');
    expect(l.messages.some((x) => x.status === 'draft')).toBe(true);
    const run = l.runs.find((r) => r.automation_name === 'Speed to lead: hot leads')!;
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.action)).toEqual(['assign_owner', 'draft_followup', 'notify', 'sync_crm']);
    expect(l.ghl_contact_id).toBeTruthy();
    expect(l.ghl_opportunity_id).toBeTruthy();
  }, 60_000);

  it('a lost reply after the CRM saved the opportunity does not create a duplicate', async () => {
    const lead = await newLead();
    const jobId = await m.enqueueSync(sql, clients['brightside-solar'], lead.id);
    let dropped = false;
    const base = m.mockTransport(sql);
    const transport: import('../src/ghl/client.js').Transport = async (req) => {
      if (!dropped && req.method === 'POST' && new URL(req.url).pathname === '/opportunities/') {
        dropped = true;
        await base(req); // the CRM saves it...
        return new Promise<Response>(() => {}); // ...and the reply never arrives
      }
      return base(req);
    };
    expect(await m.runSyncJob(sql, jobId, { transport, budgetMs: 30_000 })).toBe('succeeded');
    const log = await sql<{ outcome: string; request: string }[]>`select outcome, request from sync_attempts where job_id = ${jobId}::uuid order by id`;
    expect(log.map((x) => x.outcome)).toContain('uncertain');
    expect(log.map((x) => x.outcome)).toContain('found');
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ghl_opportunities o join leads l on l.ghl_contact_id = o.contact_id where l.id = ${lead.id}::uuid`;
    expect(n).toBe(1);
  }, 60_000);

  it('refreshes an expired access token and carries on', async () => {
    await m.setGhlMode(sql, agency.id, 'token_expired');
    const lead = await newLead();
    const jobId = await m.enqueueSync(sql, clients['brightside-solar'], lead.id);
    expect(await m.runSyncJob(sql, jobId, { budgetMs: 30_000 })).toBe('succeeded');
    const log = await sql<{ outcome: string; status: number }[]>`select outcome, status from sync_attempts where job_id = ${jobId}::uuid order by id`;
    expect(log[0]).toMatchObject({ status: 401, outcome: 'retry' });
    expect(log[1]).toMatchObject({ outcome: 'refreshed' });
    await m.setGhlMode(sql, agency.id, 'healthy');
  }, 60_000);

  it('verifies webhook signatures and ignores repeated deliveries', async () => {
    const [synced] = await sql<{ id: string; ghl_contact_id: string; ghl_location_id: string }[]>`
      select l.id, l.ghl_contact_id, c.ghl_location_id from leads l join clients c on c.id = l.client_id
      where c.agency_id = ${agency.id}::uuid and l.ghl_contact_id is not null limit 1`;
    const raw = JSON.stringify({ type: 'InboundMessage', webhookId: `evt_${Date.now()}`, locationId: synced.ghl_location_id, contactId: synced.ghl_contact_id, messageType: 'SMS', body: 'Thursday works' });
    await expect(m.handleGhlWebhook(sql, env, raw, 'sha256=forged')).rejects.toThrow(/signature/);
    const sig = await m.signWebhook(env, raw);
    const first = await m.handleGhlWebhook(sql, env, raw, sig);
    const again = await m.handleGhlWebhook(sql, env, raw, sig);
    expect(first.duplicate).toBe(false);
    expect(first.leadId).toBe(synced.id);
    expect(again.duplicate).toBe(true);
    const replies = await sql`select 1 from messages where lead_id = ${synced.id}::uuid and body = 'Thursday works'`;
    expect(replies.length).toBe(1);
  }, 60_000);

  it('keeps clients apart and viewers read-only', async () => {
    const users = await m.loadUsers(sql, agency.id);
    const tom = { agencyId: agency.id, user: users.find((u) => u.role === 'client_viewer')! };
    const priya = { agencyId: agency.id, user: users.find((u) => u.name === 'Priya Shah')! };
    await expect(m.requireClient(sql, tom, clients['brightside-solar'])).rejects.toThrow(/not on this client/);
    await expect(m.requireClient(sql, tom, clients['harbour-dental'])).resolves.toBeUndefined();
    await expect(m.requireClient(sql, tom, clients['harbour-dental'], 'write')).rejects.toThrow(/Client viewers/);
    await expect(m.requireClient(sql, priya, clients['harbour-dental'])).rejects.toThrow(/not on this client/);
    await expect(m.requireClient(sql, priya, clients['ridgeway-fibre'], 'write')).resolves.toBeUndefined();
  }, 60_000);
});
