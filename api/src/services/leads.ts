// Leads: capture, AI qualification, follow-up drafts, approval, stage changes.
import type { Sql } from '../db.js';
import type { Env } from '../env.js';
import { HttpError, notFound } from '../lib/http.js';
import { runTask } from '../ai/provider.js';
import { draftTask, qualifyTask, toAnalysis, type ConversationLine, type LeadInput } from '../ai/tasks.js';
import { enqueueSync, runSyncJob } from '../ghl/sync.js';
import { runTrigger } from '../automations/engine.js';
import { modelName } from '../lib/text.js';
import type { Actor } from './access.js';
import type { Client, Lead, LeadAnalysis, LeadSummary, Message, Stage, SyncJob } from '../../../shared/types.js';

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getClient(sql: Sql, clientId: string, withKey = false): Promise<Client> {
  const [c] = await sql<Client[]>`
    select id, slug, name, industry, location, brand_color, offer, ideal_customer, criteria, service_area,
           booking_link, tone, avg_deal_value, currency, ghl_location_id, api_key
    from clients where id = ${clientId}::uuid`;
  if (!c) throw notFound('Client not found');
  if (!withKey) delete c.api_key;
  return c;
}

const SUMMARY_COLUMNS = (sql: Sql) => sql`
  l.id, l.client_id, l.first_name, l.last_name, l.company, l.email, l.phone, l.source, l.campaign_id,
  cp.name as campaign_name, l.stage, l.score, l.priority, l.intent, l.ai_status,
  l.analysis->>'summary' as summary, l.owner_id, u.name as owner_name, l.value, l.tags,
  exists (select 1 from messages m where m.lead_id = l.id and m.status = 'draft') as has_draft,
  l.first_response_at, l.created_at, l.last_activity_at`;

export interface LeadFilters {
  stage?: string;
  priority?: string;
  source?: string;
  campaign?: string;
  q?: string;
  attention?: boolean;
}

export async function listLeads(sql: Sql, clientId: string, f: LeadFilters = {}): Promise<LeadSummary[]> {
  const q = f.q?.trim() ? `%${f.q.trim().toLowerCase()}%` : null;
  return sql<LeadSummary[]>`
    select ${SUMMARY_COLUMNS(sql)}
    from leads l left join campaigns cp on cp.id = l.campaign_id left join users u on u.id = l.owner_id
    where l.client_id = ${clientId}::uuid
      and (${f.stage ?? null}::text is null or l.stage = ${f.stage ?? null})
      and (${f.priority ?? null}::text is null or l.priority = ${f.priority ?? null})
      and (${f.source ?? null}::text is null or l.source = ${f.source ?? null})
      and (${f.campaign ?? null}::uuid is null or l.campaign_id = ${f.campaign ?? null}::uuid)
      and (${q}::text is null or lower(l.first_name || ' ' || l.last_name || ' ' || coalesce(l.company, '') || ' ' || coalesce(l.email, '')) like ${q})
      and (${!!f.attention}::boolean = false or (l.stage = 'new' and l.first_response_at is null))
    order by l.created_at desc
    limit 500`;
}

export async function getLead(sql: Sql, leadId: string, opts: { withKey?: boolean } = {}): Promise<Lead> {
  const [row] = await sql<Array<LeadSummary & { postcode: string | null; answers: Record<string, string>; message: string; analysis: LeadAnalysis | null; ghl_contact_id: string | null; ghl_opportunity_id: string | null }>>`
    select ${SUMMARY_COLUMNS(sql)}, l.postcode, l.answers, l.message, l.analysis, l.ghl_contact_id, l.ghl_opportunity_id
    from leads l left join campaigns cp on cp.id = l.campaign_id left join users u on u.id = l.owner_id
    where l.id = ${leadId}::uuid`;
  if (!row) throw notFound('Lead not found');

  const [messages, activities, runs, jobs] = await Promise.all([
    sql<Message[]>`
      select m.id, m.direction, m.channel, m.status, m.subject, m.body, m.ai, cu.name as created_by_name,
             au.name as approved_by_name, m.sent_at, m.created_at
      from messages m left join users cu on cu.id = m.created_by left join users au on au.id = m.approved_by
      where m.lead_id = ${leadId}::uuid order by m.created_at`,
    sql`select id, at, actor, kind, message from activities where lead_id = ${leadId}::uuid order by at, id`,
    sql`select r.id, r.automation_id, a.name as automation_name, r.lead_id, '' as lead_name, r.status, r.steps, r.error,
               r.started_at, r.finished_at
        from automation_runs r join automations a on a.id = r.automation_id
        where r.lead_id = ${leadId}::uuid order by r.started_at`,
    sql`select j.id, j.lead_id, j.state, j.attempts, j.next_attempt_at, j.last_error, j.updated_at,
               coalesce((select json_agg(x order by x.at, x.id) from (
                 select at, attempt, step, request, status, outcome, detail, duration_ms, id from sync_attempts where job_id = j.id
               ) x), '[]') as log
        from sync_jobs j where j.lead_id = ${leadId}::uuid`,
  ]);

  return {
    ...row,
    messages,
    activities: activities as never,
    runs: runs as never,
    sync: (jobs[0] ? { ...jobs[0], lead_name: '', client_name: '' } : null) as SyncJob | null,
    client: await getClient(sql, row.client_id, opts.withKey),
  };
}

async function leadInput(sql: Sql, leadId: string): Promise<{ input: LeadInput; clientId: string; analysis: LeadAnalysis | null; agencyId: string; ownerName: string | null }> {
  const [r] = await sql`
    select l.*, cp.name as campaign_name, c.agency_id, u.name as owner_name
    from leads l left join campaigns cp on cp.id = l.campaign_id join clients c on c.id = l.client_id
    left join users u on u.id = l.owner_id
    where l.id = ${leadId}::uuid`;
  if (!r) throw notFound('Lead not found');
  return {
    clientId: r.client_id,
    agencyId: r.agency_id,
    analysis: r.analysis,
    ownerName: r.owner_name,
    input: {
      first_name: r.first_name,
      last_name: r.last_name,
      company: r.company,
      email: r.email,
      phone: r.phone,
      postcode: r.postcode,
      source: r.source,
      campaign_name: r.campaign_name,
      answers: r.answers,
      message: r.message,
      created_at: new Date(r.created_at).toISOString(),
    },
  };
}

async function conversation(sql: Sql, leadId: string): Promise<ConversationLine[]> {
  const rows = await sql<{ direction: 'inbound' | 'outbound'; channel: string; body: string; at: Date }[]>`
    select direction, channel, body, coalesce(sent_at, created_at) as at from messages
    where lead_id = ${leadId}::uuid and status in ('received', 'sent') and channel <> 'form'
    order by coalesce(sent_at, created_at)`;
  return rows.map((m) => ({ direction: m.direction, channel: m.channel, body: m.body, at: new Date(m.at).toISOString() }));
}

export async function logActivity(sql: Sql, leadId: string, actor: string, kind: string, message: string, data?: Record<string, unknown>) {
  await sql`
    insert into activities (lead_id, client_id, actor, kind, message, data)
    select ${leadId}::uuid, client_id, ${actor}, ${kind}, ${message}, ${data ? sql.json(data as never) : null}
    from leads where id = ${leadId}::uuid`;
  await sql`update leads set last_activity_at = now() where id = ${leadId}::uuid`;
}

// ── Capture ─────────────────────────────────────────────────────────────────

export interface NewLead {
  first_name: string;
  last_name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  postcode?: string | null;
  answers?: Record<string, string>;
  message?: string;
  source?: string;
  utm_campaign?: string | null;
}

const SOURCES = ['meta', 'google', 'tiktok', 'linkedin', 'email', 'organic', 'referral'];

export function validateNewLead(body: unknown): NewLead {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 200) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, max) : undefined);
  const first = str('first_name', 80);
  if (!first) throw new HttpError(422, 'first_name is required');
  const email = str('email', 200) || null;
  const phone = str('phone', 40) || null;
  if (!email && !phone) throw new HttpError(422, 'An email or a phone number is required');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, 'email is not valid');
  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === 'object') {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>).slice(0, 12)) {
      if (typeof v === 'string' || typeof v === 'number') answers[k.slice(0, 60)] = String(v).slice(0, 200);
    }
  }
  const source = str('source', 20);
  return {
    first_name: first,
    last_name: str('last_name', 80) ?? '',
    email,
    phone,
    company: str('company', 120) || null,
    postcode: str('postcode', 12)?.toUpperCase() || null,
    answers,
    message: str('message', 2000) ?? '',
    source: source && SOURCES.includes(source) ? source : undefined,
    utm_campaign: str('utm_campaign', 80) || null,
  };
}

/**
 * Stores a new lead and runs the "lead.created" automations. Returns the id and a function that
 * qualifies it with AI and runs the "lead.qualified" automations; callers run that in the
 * background so the form responds immediately.
 */
export async function createLead(sql: Sql, env: Env, clientId: string, input: NewLead, via: string) {
  const [campaign] = input.utm_campaign
    ? await sql<{ id: string; source: string }[]>`select id, source from campaigns where client_id = ${clientId}::uuid and utm_campaign = ${input.utm_campaign}`
    : [];
  const source = input.source ?? campaign?.source ?? 'organic';
  const [lead] = await sql<{ id: string }[]>`
    insert into leads (client_id, campaign_id, source, first_name, last_name, email, phone, company, postcode, answers, message)
    values (${clientId}::uuid, ${campaign?.id ?? null}::uuid, ${source}, ${input.first_name}, ${input.last_name ?? ''},
            ${input.email ?? null}, ${input.phone ?? null}, ${input.company ?? null}, ${input.postcode ?? null},
            ${sql.json((input.answers ?? {}) as never)}, ${input.message ?? ''})
    returning id`;
  if (input.message) {
    await sql`insert into messages (lead_id, direction, channel, status, body) values (${lead.id}::uuid, 'inbound', 'form', 'received', ${input.message})`;
  }
  await logActivity(sql, lead.id, 'system', 'created', `New lead from ${via}${campaign ? ` (${input.utm_campaign})` : ''}.`);
  await runTrigger(sql, env, lead.id, 'lead.created');
  return { id: lead.id, process: () => qualifyAndRoute(sql, env, lead.id) };
}

export async function qualifyAndRoute(sql: Sql, env: Env, leadId: string) {
  await qualifyLead(sql, env, leadId);
  await runTrigger(sql, env, leadId, 'lead.qualified');
}

export async function qualifyLead(sql: Sql, env: Env, leadId: string): Promise<LeadAnalysis> {
  const { input, clientId, agencyId } = await leadInput(sql, leadId);
  const client = await getClient(sql, clientId);
  const res = await runTask({ env, sql, agencyId }, qualifyTask(client, input, await conversation(sql, leadId)));
  const analysis = toAnalysis(res.data, res.provider, res.model, res.ms);
  await sql`
    update leads set ai_status = 'done', score = ${analysis.score}, priority = ${analysis.priority}, intent = ${analysis.intent},
           analysis = ${sql.json(analysis as never)}, last_activity_at = now()
    where id = ${leadId}::uuid`;
  const who = res.provider === 'anthropic' ? modelName(res.model) : 'Demo rules (no AI call)';
  await logActivity(sql, leadId, 'ai', 'qualified', `${who} scored ${analysis.score}/100, ${analysis.priority} priority: ${analysis.summary}`, res.note ? { note: res.note } : undefined);
  return analysis;
}

// ── Follow-ups ──────────────────────────────────────────────────────────────

export async function draftFollowUp(
  sql: Sql,
  env: Env,
  leadId: string,
  opts: { channel: 'email' | 'sms'; instruction?: string; createdBy: string | null; actorName: string },
): Promise<Message> {
  const { input, clientId, analysis, agencyId, ownerName } = await leadInput(sql, leadId);
  const client = await getClient(sql, clientId);
  const sender = ownerName ?? opts.actorName;
  const res = await runTask(
    { env, sql, agencyId },
    draftTask(client, input, analysis, await conversation(sql, leadId), { channel: opts.channel, sender: sender.split(' ')[0], instruction: opts.instruction }),
  );
  // One pending draft per lead: a new draft replaces the old one.
  await sql`update messages set status = 'rejected' where lead_id = ${leadId}::uuid and status = 'draft'`;
  const [m] = await sql<{ id: string }[]>`
    insert into messages (lead_id, direction, channel, status, subject, body, ai, created_by)
    values (${leadId}::uuid, 'outbound', ${opts.channel}, 'draft', ${opts.channel === 'email' ? res.data.subject || null : null}, ${res.data.body},
            ${sql.json({ provider: res.provider, model: res.model, rationale: res.data.rationale, facts_used: res.data.facts_used, note: res.note ?? null } as never)},
            ${opts.createdBy}::uuid)
    returning id`;
  const who = res.provider === 'anthropic' ? modelName(res.model) : 'Demo template (no AI call)';
  await logActivity(sql, leadId, opts.actorName === 'automation' ? 'automation' : 'ai', 'drafted', `${who} drafted ${opts.channel === 'sms' ? 'an SMS' : 'an email'} for review.`);
  const [msg] = await sql<Message[]>`select id, direction, channel, status, subject, body, ai, null as created_by_name, null as approved_by_name, sent_at, created_at from messages where id = ${m.id}::uuid`;
  return msg;
}

async function messageLead(sql: Sql, messageId: string) {
  const [m] = await sql<{ lead_id: string; status: string; channel: string }[]>`select lead_id, status, channel from messages where id = ${messageId}::uuid`;
  if (!m) throw notFound('Message not found');
  return m;
}

export async function leadIdForMessage(sql: Sql, messageId: string) {
  return (await messageLead(sql, messageId)).lead_id;
}

export async function editDraft(sql: Sql, messageId: string, patch: { body?: string; subject?: string | null }) {
  const m = await messageLead(sql, messageId);
  if (m.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited.');
  await sql`update messages set body = coalesce(${patch.body?.slice(0, 4000) ?? null}, body), subject = coalesce(${patch.subject ?? null}, subject) where id = ${messageId}::uuid`;
}

/**
 * A person approves a draft and it goes out. Sending is simulated in the demo (no real email or
 * SMS provider is connected); the message is marked sent, the response time is recorded, and the
 * lead moves from New to Contacted.
 */
export async function approveMessage(sql: Sql, env: Env, messageId: string, actor: Actor) {
  const m = await messageLead(sql, messageId);
  if (m.status !== 'draft') throw new HttpError(409, 'This message has already been handled.');
  await sql`update messages set status = 'sent', approved_by = ${actor.user.id}::uuid, sent_at = now() where id = ${messageId}::uuid`;
  const [lead] = await sql<{ stage: Stage; first_response_at: string | null }[]>`select stage, first_response_at from leads where id = ${m.lead_id}::uuid`;
  await sql`update leads set first_response_at = coalesce(first_response_at, now()), owner_id = coalesce(owner_id, ${actor.user.id}::uuid) where id = ${m.lead_id}::uuid`;
  await logActivity(sql, m.lead_id, actor.user.name, 'message_sent', `${actor.user.name} approved and sent the ${m.channel === 'sms' ? 'SMS' : 'email'} (simulated delivery).`);
  if (lead.stage === 'new') await changeStage(sql, env, m.lead_id, 'contacted', actor.user.name);
}

export async function rejectMessage(sql: Sql, messageId: string, actor: Actor) {
  const m = await messageLead(sql, messageId);
  if (m.status !== 'draft') throw new HttpError(409, 'This message has already been handled.');
  await sql`update messages set status = 'rejected' where id = ${messageId}::uuid`;
  await logActivity(sql, m.lead_id, actor.user.name, 'draft_rejected', `${actor.user.name} discarded the draft.`);
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export async function changeStage(sql: Sql, env: Env, leadId: string, stage: Stage, actorName: string) {
  const [before] = await sql<{ stage: Stage; ghl_contact_id: string | null; client_id: string }[]>`select stage, ghl_contact_id, client_id from leads where id = ${leadId}::uuid`;
  if (!before || before.stage === stage) return;
  await sql`update leads set stage = ${stage} where id = ${leadId}::uuid`;
  await logActivity(sql, leadId, actorName, 'stage_changed', `Moved from ${before.stage} to ${stage}.`, { from: before.stage, to: stage });
  // Keep the CRM in step once the lead is there.
  if (before.ghl_contact_id) {
    const jobId = await enqueueSync(sql, before.client_id, leadId);
    await runSyncJob(sql, jobId, { budgetMs: 4000 });
  }
  await runTrigger(sql, env, leadId, 'stage.changed');
}

export async function patchLead(sql: Sql, env: Env, leadId: string, actor: Actor, patch: { stage?: Stage; owner_id?: string | null; value?: number | null; tags?: string[] }) {
  const stages: Stage[] = ['new', 'contacted', 'qualified', 'booked', 'won', 'lost'];
  if (patch.owner_id !== undefined) {
    const [u] = patch.owner_id
      ? await sql<{ name: string }[]>`select name from users where id = ${patch.owner_id}::uuid and agency_id = ${actor.agencyId}::uuid`
      : [{ name: 'nobody' }];
    if (!u) throw new HttpError(422, 'Unknown user');
    await sql`update leads set owner_id = ${patch.owner_id}::uuid where id = ${leadId}::uuid`;
    await logActivity(sql, leadId, actor.user.name, 'assigned', `Assigned to ${u.name}.`);
  }
  if (patch.value !== undefined) {
    await sql`update leads set value = ${patch.value} where id = ${leadId}::uuid`;
    await logActivity(sql, leadId, actor.user.name, 'value_changed', patch.value == null ? 'Cleared the deal value.' : `Set the deal value to £${patch.value.toLocaleString('en-GB')}.`);
  }
  if (patch.tags) {
    const tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
    await sql`update leads set tags = ${tags}::text[] where id = ${leadId}::uuid`;
  }
  if (patch.stage) {
    if (!stages.includes(patch.stage)) throw new HttpError(422, 'Unknown stage');
    await changeStage(sql, env, leadId, patch.stage, actor.user.name);
  }
}

export async function addNote(sql: Sql, leadId: string, actor: Actor, body: string) {
  const text = body.trim().slice(0, 2000);
  if (!text) throw new HttpError(422, 'Write something first.');
  await sql`insert into messages (lead_id, direction, channel, status, body, created_by) values (${leadId}::uuid, 'outbound', 'note', 'sent', ${text}, ${actor.user.id}::uuid)`;
  await logActivity(sql, leadId, actor.user.name, 'note', `${actor.user.name} added a note.`);
}

export async function syncLeadNow(sql: Sql, leadId: string, clientId: string, actorName: string) {
  const jobId = await enqueueSync(sql, clientId, leadId);
  await logActivity(sql, leadId, actorName, 'crm_queued', 'Queued for GoHighLevel sync (simulated CRM).');
  return runSyncJob(sql, jobId);
}
