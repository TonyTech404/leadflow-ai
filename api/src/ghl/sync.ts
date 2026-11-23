// Pushes leads to the CRM (GoHighLevel) through an outbox.
//
// One sync_jobs row per lead. A job is claimed with a short lock so two clicks or two workers
// never push the same lead at once. Each run makes the CRM match the lead:
//   1. upsert the contact (GHL matches on email/phone, so repeating it is safe)
//   2. update the opportunity if we know its id; otherwise, if an earlier attempt may have created
//      one (timeout), search for it first; only then create it
// Failures are sorted: 429/503 back off and retry, a timeout marks the job "uncertain", 401
// refreshes the access token once, and 400/422 stop and wait for a person.
import type { Sql } from '../db.js';
import { GhlClient, GhlError, refreshAccessToken, type Transport } from './client.js';
import { DROP_HEADER, GHL_BASE, GHL_VERSION, ghlMock } from './mock.js';

export const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.GHL_TIMEOUT_MS ?? 3000);

export function backoffMs(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.75 + random * 0.5));
}

/** Our pipeline stages, as stage ids in the client's GHL pipeline. */
export function ghlStage(slug: string, stage: string) {
  const status = stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : 'open';
  return { pipelineId: `pl-${slug}`, pipelineStageId: `${slug}-${stage}`, status } as const;
}

/** Calls the simulation in-process; drops the reply when it says to, like a flaky network. */
export function mockTransport(sql: Sql): Transport {
  return async (req) => {
    const url = new URL(req.url);
    const body = req.method === 'GET' ? undefined : await req.text();
    const res = await ghlMock.fetch(new Request(`http://ghl${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body }), { sql });
    if (res.headers.get(DROP_HEADER)) return new Promise<Response>(() => {});
    return res;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Queues the lead for syncing (or re-queues a failed job). Returns the job id. */
export async function enqueueSync(sql: Sql, clientId: string, leadId: string): Promise<string> {
  const [job] = await sql<{ id: string }[]>`
    insert into sync_jobs (client_id, lead_id) values (${clientId}::uuid, ${leadId}::uuid)
    on conflict (lead_id) do nothing returning id`;
  if (job) return job.id;
  const [existing] = await sql<{ id: string }[]>`
    update sync_jobs set state = case when state in ('succeeded', 'failed') then 'pending' else state end,
           attempts = case when state in ('succeeded', 'failed') then 0 else attempts end, next_attempt_at = now(), updated_at = now()
    where lead_id = ${leadId}::uuid returning id`;
  return existing.id;
}

interface Ctx {
  job: { id: string; lead_id: string; attempts: number; uncertain: boolean };
  agency: { id: string; ghl_client_token_version: number };
  client: { slug: string; ghl_location_id: string; name: string };
  lead: {
    first_name: string; last_name: string; email: string | null; phone: string | null; source: string; stage: string;
    value: number | null; tags: string[]; score: number | null; priority: string | null; campaign: string | null;
    ghl_contact_id: string | null; ghl_opportunity_id: string | null;
  };
}

async function claim(sql: Sql, jobId: string): Promise<Ctx | null> {
  const [job] = await sql<Ctx['job'][]>`
    update sync_jobs set locked_until = now() + interval '60 seconds', updated_at = now()
    where id = ${jobId}::uuid and state in ('pending', 'retrying') and (locked_until is null or locked_until < now())
    returning id, lead_id, attempts, uncertain`;
  if (!job) return null;
  const [r] = await sql`
    select a.id as agency_id, a.ghl_client_token_version, c.slug, c.ghl_location_id, c.name as client_name,
           l.first_name, l.last_name, l.email, l.phone, l.source, l.stage, l.value, l.tags, l.score, l.priority,
           l.ghl_contact_id, l.ghl_opportunity_id, cp.name as campaign
    from leads l join clients c on c.id = l.client_id join agencies a on a.id = c.agency_id
    left join campaigns cp on cp.id = l.campaign_id
    where l.id = ${job.lead_id}::uuid`;
  return {
    job,
    agency: { id: r.agency_id, ghl_client_token_version: r.ghl_client_token_version },
    client: { slug: r.slug, ghl_location_id: r.ghl_location_id, name: r.client_name },
    lead: r as unknown as Ctx['lead'],
  };
}

export type SyncOutcome = 'succeeded' | 'retrying' | 'failed' | 'busy';

/** Runs one job until it succeeds, fails for good, or uses up this request's time. */
export async function runSyncJob(sql: Sql, jobId: string, opts: { budgetMs?: number; transport?: Transport } = {}): Promise<SyncOutcome> {
  const ctx = await claim(sql, jobId);
  if (!ctx) return 'busy';
  const { job, agency, client, lead } = ctx;
  const transport = opts.transport ?? mockTransport(sql);
  const budget = opts.budgetMs ?? 9000;
  const started = Date.now();
  let attempts = job.attempts;
  let uncertain = job.uncertain;
  let tokenVersion = agency.ghl_client_token_version;
  let refreshed = false;

  const ghl = new GhlClient(transport, {
    baseUrl: GHL_BASE,
    locationId: client.ghl_location_id,
    version: GHL_VERSION,
    timeoutMs: TIMEOUT_MS,
    getToken: async () => `demo-${agency.id}-v${tokenVersion}`,
  });

  const log = async (step: string, request: string, status: number | null, outcome: string, detail: string | null, since: number) => {
    await sql`insert into sync_attempts (job_id, attempt, step, request, status, outcome, detail, duration_ms)
              values (${job.id}::uuid, ${attempts}, ${step}, ${request}, ${status}, ${outcome}, ${detail}, ${Date.now() - since})`;
  };
  const activity = (kind: string, message: string) =>
    sql`insert into activities (lead_id, client_id, actor, kind, message)
        select ${job.lead_id}::uuid, client_id, 'system', ${kind}, ${message} from leads where id = ${job.lead_id}::uuid`;

  const target = ghlStage(client.slug, lead.stage);

  while (true) {
    attempts += 1;
    let step = 'contact';
    let request = '';
    let since = Date.now();
    try {
      // 1. Contact: upsert is idempotent on email/phone.
      request = 'POST /contacts/upsert';
      const contact = await ghl.upsertContact({
        firstName: lead.first_name,
        lastName: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        source: `LeadFlow: ${lead.campaign ?? lead.source}`,
        tags: [...lead.tags, lead.priority ? `priority-${lead.priority}` : 'unscored'],
        customFields: [{ key: 'leadflow_score', field_value: String(lead.score ?? '') }],
      });
      await log(step, request, contact.created ? 201 : 200, 'ok', contact.created ? 'Created contact' : 'Updated existing contact', since);
      if (contact.id !== lead.ghl_contact_id) {
        lead.ghl_contact_id = contact.id;
        await sql`update leads set ghl_contact_id = ${contact.id} where id = ${job.lead_id}::uuid`;
      }

      // 2. Opportunity.
      step = 'opportunity';
      let oppId = lead.ghl_opportunity_id;
      if (!oppId && uncertain) {
        request = `GET /opportunities/search?contact_id=${contact.id}`;
        since = Date.now();
        const found = await ghl.findOpportunities(contact.id);
        await log(step, request, 200, found.length ? 'found' : 'ok', found.length ? 'An earlier attempt had already created it' : 'Not there yet, safe to create', since);
        if (found.length) oppId = found[0].id;
        uncertain = false;
      }
      since = Date.now();
      if (oppId) {
        request = `PUT /opportunities/${oppId}`;
        await ghl.updateOpportunity(oppId, { pipelineStageId: target.pipelineStageId, status: target.status, monetaryValue: lead.value });
        await log(step, request, 200, 'ok', `Stage ${lead.stage}`, since);
      } else {
        request = 'POST /opportunities/';
        const opp = await ghl.createOpportunity({
          name: `${lead.first_name} ${lead.last_name}`.trim() + ` – ${client.name}`,
          contactId: contact.id,
          pipelineId: target.pipelineId,
          pipelineStageId: target.pipelineStageId,
          status: target.status,
          monetaryValue: lead.value,
        });
        oppId = opp.id;
        await log(step, request, 201, 'ok', `Created in stage ${lead.stage}`, since);
      }
      await sql`update leads set ghl_opportunity_id = ${oppId} where id = ${job.lead_id}::uuid`;
      await sql`update sync_jobs set state = 'succeeded', attempts = ${attempts}, uncertain = false, locked_until = null, last_error = null, updated_at = now() where id = ${job.id}::uuid`;
      await activity('crm_synced', `Synced to GoHighLevel (simulated)${attempts > 1 ? ` after ${attempts} attempts` : ''}.`);
      return 'succeeded';
    } catch (e) {
      if (!(e instanceof GhlError)) throw e;

      if (e.kind === 'auth' && !refreshed) {
        await log(step, request, 401, 'retry', e.message, since);
        since = Date.now();
        const token = await refreshAccessToken(transport, GHL_BASE, `demo-refresh-${agency.id}`, TIMEOUT_MS);
        tokenVersion = Number(token.match(/-v(\d+)$/)?.[1] ?? tokenVersion);
        await sql`update agencies set ghl_client_token_version = ${tokenVersion} where id = ${agency.id}::uuid`;
        await log('token', 'POST /oauth/token', 200, 'refreshed', 'Refreshed the access token', since);
        refreshed = true;
        attempts -= 1; // the refresh is part of the same attempt
        continue;
      }

      const outcome = !e.transient ? 'fatal' : e.uncertain && step === 'opportunity' && request.startsWith('POST') ? 'uncertain' : 'retry';
      await log(step, request, e.status, outcome, e.message, since);
      if (outcome === 'uncertain') uncertain = true;

      if (!e.transient || attempts >= MAX_ATTEMPTS) {
        const reason = !e.transient ? `GoHighLevel rejected it: ${e.message}` : `Gave up after ${attempts} attempts: ${e.message}`;
        await sql`update sync_jobs set state = 'failed', attempts = ${attempts}, uncertain = ${uncertain}, locked_until = null, last_error = ${reason}, updated_at = now() where id = ${job.id}::uuid`;
        await activity('crm_failed', reason);
        return 'failed';
      }

      const wait = Math.max(backoffMs(attempts), e.retryAfterMs ?? 0);
      if (Date.now() - started + wait > budget) {
        await sql`update sync_jobs set state = 'retrying', attempts = ${attempts}, uncertain = ${uncertain}, locked_until = null, last_error = ${e.message},
                    next_attempt_at = now() + ${Math.max(wait, 15000)} * interval '1 millisecond', updated_at = now()
                  where id = ${job.id}::uuid`;
        return 'retrying';
      }
      await sql`update sync_jobs set attempts = ${attempts}, uncertain = ${uncertain}, last_error = ${e.message}, updated_at = now() where id = ${job.id}::uuid`;
      await sleep(wait);
    }
  }
}

export async function runDueSyncJobs(sql: Sql, opts: { agencyId?: string; limit?: number; budgetMs?: number } = {}) {
  const due = await sql<{ id: string }[]>`
    select j.id from sync_jobs j join clients c on c.id = j.client_id
    where j.state in ('pending', 'retrying') and j.next_attempt_at <= now()
      and (${opts.agencyId ?? null}::uuid is null or c.agency_id = ${opts.agencyId ?? null}::uuid)
    order by j.next_attempt_at limit ${opts.limit ?? 10}`;
  const result: Record<SyncOutcome, number> = { succeeded: 0, retrying: 0, failed: 0, busy: 0 };
  for (const { id } of due) result[await runSyncJob(sql, id, { budgetMs: opts.budgetMs ?? 5000 })] += 1;
  return { ran: due.length, ...result };
}
