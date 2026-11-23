// Automation engine: "when <trigger>, if <all conditions>, do <actions in order>".
//
// - Triggers: lead.created, lead.qualified, stage.changed (fired by the app) and no_reply
//   (found by a scheduled tick: a new lead nobody has answered within N minutes).
// - An automation runs at most once per lead (unique row in automation_runs). A run is recorded
//   only when the conditions match, so a stage.changed rule waiting for "won" still fires later.
// - Every step is logged with its outcome, time and attempts. A failed step stops the run.
// - Outbound webhooks retry with backoff. In the demo they go to a simulated receiver, never to
//   arbitrary URLs, so the public demo can't be used to send traffic elsewhere.
import type { Sql } from '../db.js';
import type { Env } from '../env.js';
import { backoffMs, enqueueSync, runSyncJob } from '../ghl/sync.js';
import { changeStage, draftFollowUp, logActivity } from '../services/leads.js';
import { modelName } from '../lib/text.js';
import type { Action, AutomationStep, AutomationTrigger, Condition, Stage } from '../../../shared/types.js';

interface LeadFacts {
  id: string;
  client_id: string;
  first_name: string;
  priority: string | null;
  score: number | null;
  intent: string | null;
  source: string;
  stage: string;
  tags: string[];
}

export function matches(cond: Condition, lead: LeadFacts): boolean {
  const actual = cond.field === 'tag' ? lead.tags : (lead[cond.field as keyof LeadFacts] as string | number | null);
  const v = cond.value;
  switch (cond.op) {
    case 'eq':
      return actual === v;
    case 'neq':
      return actual !== v;
    case 'gte':
      return typeof actual === 'number' && actual >= Number(v);
    case 'lte':
      return typeof actual === 'number' && actual <= Number(v);
    case 'in':
      return Array.isArray(v) && v.includes(String(actual));
    case 'has':
      return Array.isArray(actual) && actual.includes(String(v));
    default:
      return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadFacts(sql: Sql, leadId: string): Promise<LeadFacts | null> {
  const [l] = await sql<LeadFacts[]>`select id, client_id, first_name, priority, score, intent, source, stage, tags from leads where id = ${leadId}::uuid`;
  return l ?? null;
}

let depth = 0;

/** Runs every enabled automation for this trigger whose conditions match the lead. */
export async function runTrigger(sql: Sql, env: Env, leadId: string, trigger: AutomationTrigger) {
  if (depth > 2) return; // an action that changes stage can fire stage.changed; stop runaway chains
  depth += 1;
  try {
    const lead = await loadFacts(sql, leadId);
    if (!lead) return;
    const automations = await sql<{ id: string; name: string; conditions: Condition[]; actions: Action[] }[]>`
      select id, name, conditions, actions from automations
      where client_id = ${lead.client_id}::uuid and enabled and trigger = ${trigger}
        and not exists (select 1 from automation_runs r where r.automation_id = automations.id and r.lead_id = ${leadId}::uuid)
      order by created_at`;
    for (const a of automations) {
      const fresh = (await loadFacts(sql, leadId))!;
      if (a.conditions.every((c) => matches(c, fresh))) await execute(sql, env, a, fresh);
    }
  } finally {
    depth -= 1;
  }
}

async function execute(sql: Sql, env: Env, automation: { id: string; name: string; actions: Action[] }, lead: LeadFacts) {
  const [run] = await sql<{ id: string }[]>`
    insert into automation_runs (automation_id, lead_id, status) values (${automation.id}::uuid, ${lead.id}::uuid, 'running')
    on conflict (automation_id, lead_id) do nothing returning id`;
  if (!run) return; // another worker got there first

  const steps: AutomationStep[] = [];
  let failed: string | null = null;
  for (const action of automation.actions) {
    if (failed) {
      steps.push({ action: action.type, status: 'skipped', detail: 'Skipped after an earlier step failed.', ms: 0, attempts: 0 });
      continue;
    }
    const started = Date.now();
    try {
      const { detail, attempts } = await perform(sql, env, action, lead);
      steps.push({ action: action.type, status: 'succeeded', detail, ms: Date.now() - started, attempts });
    } catch (e) {
      failed = (e as Error).message;
      steps.push({ action: action.type, status: 'failed', detail: failed, ms: Date.now() - started, attempts: (e as { attempts?: number }).attempts ?? 1 });
    }
  }
  await sql`
    update automation_runs set status = ${failed ? 'failed' : 'succeeded'}, steps = ${sql.json(steps as never)}, error = ${failed}, finished_at = now()
    where id = ${run.id}::uuid`;
  await logActivity(sql, lead.id, 'automation', 'automation_ran', `Automation "${automation.name}" ${failed ? `failed: ${failed}` : `ran ${steps.length} step${steps.length === 1 ? '' : 's'}`}.`);
}

async function perform(sql: Sql, env: Env, action: Action, lead: LeadFacts): Promise<{ detail: string; attempts: number }> {
  const p = action.params;
  switch (action.type) {
    case 'assign_owner': {
      // Round robin: the account manager on this client with the fewest open leads.
      const [owner] = await sql<{ id: string; name: string }[]>`
        select u.id, u.name from users u join memberships m on m.user_id = u.id
        where m.client_id = ${lead.client_id}::uuid and u.role = 'account_manager'
        order by (select count(*) from leads l where l.owner_id = u.id and l.stage not in ('won', 'lost')), u.name
        limit 1`;
      const fallback = owner ?? (await sql<{ id: string; name: string }[]>`
        select u.id, u.name from users u join clients c on c.agency_id = u.agency_id
        where c.id = ${lead.client_id}::uuid and u.role = 'agency_admin' order by u.name limit 1`)[0];
      if (!fallback) throw new Error('Nobody to assign to.');
      await sql`update leads set owner_id = ${fallback.id}::uuid where id = ${lead.id}::uuid`;
      return { detail: `Assigned to ${fallback.name} (round robin).`, attempts: 1 };
    }
    case 'draft_followup': {
      const channel = p.channel === 'email' ? 'email' : 'sms';
      const msg = await draftFollowUp(sql, env, lead.id, { channel, createdBy: null, actorName: 'automation' });
      const by = msg.ai?.provider === 'anthropic' ? modelName(msg.ai.model) : 'the demo template';
      return { detail: `Drafted ${channel === 'sms' ? 'an SMS' : 'an email'} with ${by}. Waiting for a person to approve it.`, attempts: 1 };
    }
    case 'add_tag': {
      const tag = String(p.tag ?? '').toLowerCase();
      if (!tag) throw new Error('No tag given.');
      await sql`update leads set tags = (select array(select distinct unnest(tags || ${[tag]}::text[]))) where id = ${lead.id}::uuid`;
      return { detail: `Tagged "${tag}".`, attempts: 1 };
    }
    case 'move_stage': {
      const stage = String(p.stage) as Stage;
      await changeStage(sql, env, lead.id, stage, 'automation');
      return { detail: `Moved to ${stage}.`, attempts: 1 };
    }
    case 'notify': {
      // No chat workspace is connected in the demo: the message is recorded, not delivered.
      const target = String(p.target ?? '#leads');
      return {
        detail: `Simulated: would post to Slack ${target}: "${lead.first_name}, ${lead.priority ?? 'unscored'} priority (${lead.score ?? '?'}), ${lead.source}."`,
        attempts: 1,
      };
    }
    case 'sync_crm': {
      const jobId = await enqueueSync(sql, lead.client_id, lead.id);
      const outcome = await runSyncJob(sql, jobId, { budgetMs: 6000 });
      if (outcome === 'failed') throw Object.assign(new Error('GoHighLevel sync failed; see the sync log.'), { attempts: 1 });
      return {
        detail:
          outcome === 'succeeded'
            ? 'Pushed to GoHighLevel (simulated CRM).'
            : outcome === 'retrying'
              ? 'GoHighLevel is not responding; the sync will retry automatically.'
              : 'Already syncing.',
        attempts: 1,
      };
    }
    case 'webhook': {
      const url = String(p.url ?? '');
      return deliverWebhook(url, { event: 'lead.qualified', lead_id: lead.id, priority: lead.priority, score: lead.score });
    }
  }
}

/** Simulated outbound webhook: a receiver that fails some first attempts, to exercise retries. */
async function deliverWebhook(url: string, payload: Record<string, unknown>) {
  if (!/^https:\/\/hooks\.example\.com\//.test(url)) throw new Error('Demo webhooks may only target https://hooks.example.com/.');
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ok = attempt > 1 || Math.random() > 0.35;
    if (ok) return { detail: `Simulated: delivered ${body.length} bytes to ${url}${attempt > 1 ? ` on attempt ${attempt}` : ''}.`, attempts: attempt };
    await sleep(backoffMs(attempt) / 4);
  }
  throw Object.assign(new Error(`Receiver at ${url} kept failing.`), { attempts: 4 });
}

/**
 * Fires no_reply automations for leads nobody has answered in time. Only leads created after the
 * sandbox (not the seeded history), so opening the demo doesn't fire a burst of AI drafts.
 */
export async function tickNoReply(sql: Sql, env: Env, opts: { agencyId?: string; limit?: number } = {}) {
  const due = await sql<{ lead_id: string }[]>`
    select l.id as lead_id from automations a
    join leads l on l.client_id = a.client_id
    join clients c on c.id = l.client_id
    join agencies ag on ag.id = c.agency_id
    where a.enabled and a.trigger = 'no_reply'
      and l.stage = 'new' and l.first_response_at is null and l.created_at > ag.created_at
      and l.created_at < now() - (a.delay_minutes * interval '1 minute')
      and (${opts.agencyId ?? null}::uuid is null or ag.id = ${opts.agencyId ?? null}::uuid)
      and not exists (select 1 from automation_runs r where r.automation_id = a.id and r.lead_id = l.id)
    limit ${opts.limit ?? 10}`;
  for (const { lead_id } of due) await runTrigger(sql, env, lead_id, 'no_reply');
  return due.length;
}
