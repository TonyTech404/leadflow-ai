import type { Sql } from '../db.js';
import { HttpError, notFound } from '../lib/http.js';
import type { Action, ActionType, Automation, AutomationRun, AutomationTrigger, Condition } from '../../../shared/types.js';

export async function listAutomations(sql: Sql, clientId: string): Promise<Automation[]> {
  return sql<Automation[]>`
    select a.id, a.name, a.enabled, a.trigger, a.delay_minutes, a.conditions, a.actions,
           count(r.id)::int as runs_total, count(r.id) filter (where r.status = 'failed')::int as runs_failed,
           max(r.started_at) as last_run_at
    from automations a left join automation_runs r on r.automation_id = a.id
    where a.client_id = ${clientId}::uuid
    group by a.id order by a.created_at`;
}

export async function listRuns(sql: Sql, clientId: string): Promise<AutomationRun[]> {
  return sql<AutomationRun[]>`
    select r.id, r.automation_id, a.name as automation_name, r.lead_id, l.first_name || ' ' || l.last_name as lead_name,
           r.status, r.steps, r.error, r.started_at, r.finished_at
    from automation_runs r join automations a on a.id = r.automation_id join leads l on l.id = r.lead_id
    where a.client_id = ${clientId}::uuid
    order by r.started_at desc limit 60`;
}

const TRIGGERS: AutomationTrigger[] = ['lead.created', 'lead.qualified', 'stage.changed', 'no_reply'];
const ACTIONS: ActionType[] = ['assign_owner', 'draft_followup', 'add_tag', 'move_stage', 'notify', 'sync_crm', 'webhook'];
const FIELDS = ['priority', 'score', 'intent', 'source', 'stage', 'tag'];
const OPS = ['eq', 'neq', 'gte', 'lte', 'in', 'has'];

export function validateAutomation(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(422, 'Give the automation a name.');
  const trigger = b.trigger as AutomationTrigger;
  if (!TRIGGERS.includes(trigger)) throw new HttpError(422, 'Unknown trigger.');
  const delay = Math.max(0, Math.min(1440, Math.round(Number(b.delay_minutes ?? 0)) || 0));
  if (trigger === 'no_reply' && delay < 1) throw new HttpError(422, 'A "no reply" automation needs a delay of at least a minute.');

  const conditions = (Array.isArray(b.conditions) ? b.conditions : []).slice(0, 6).map((x) => {
    const c = x as Condition;
    if (!FIELDS.includes(c.field) || !OPS.includes(c.op)) throw new HttpError(422, 'A condition is incomplete.');
    return { field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.map(String).slice(0, 10) : c.field === 'score' ? Number(c.value) : String(c.value) };
  });

  const actions = (Array.isArray(b.actions) ? b.actions : []).slice(0, 8).map((x) => {
    const a = x as Action;
    if (!ACTIONS.includes(a.type)) throw new HttpError(422, `Unknown action "${a.type}".`);
    const params = (a.params ?? {}) as Record<string, string | number | boolean>;
    if (a.type === 'webhook' && !/^https:\/\/hooks\.example\.com\/[\w\-/]*$/.test(String(params.url ?? ''))) {
      throw new HttpError(422, 'In the demo, webhooks can only target https://hooks.example.com/… (a simulated receiver).');
    }
    if (a.type === 'add_tag' && !String(params.tag ?? '').trim()) throw new HttpError(422, 'Say which tag to add.');
    if (a.type === 'move_stage' && !['new', 'contacted', 'qualified', 'booked', 'won', 'lost'].includes(String(params.stage))) throw new HttpError(422, 'Pick a stage.');
    return { type: a.type, params };
  });
  if (!actions.length) throw new HttpError(422, 'Add at least one action.');

  return { name, trigger, delay, conditions, actions, enabled: b.enabled !== false };
}

export async function saveAutomation(sql: Sql, clientId: string, id: string | null, body: unknown) {
  const v = validateAutomation(body);
  if (id) {
    const [row] = await sql`
      update automations set name = ${v.name}, trigger = ${v.trigger}, delay_minutes = ${v.delay}, enabled = ${v.enabled},
             conditions = ${sql.json(v.conditions as never)}, actions = ${sql.json(v.actions as never)}
      where id = ${id}::uuid and client_id = ${clientId}::uuid returning id`;
    if (!row) throw notFound('Automation not found');
  } else {
    await sql`
      insert into automations (client_id, name, trigger, delay_minutes, enabled, conditions, actions)
      values (${clientId}::uuid, ${v.name}, ${v.trigger}, ${v.delay}, ${v.enabled}, ${sql.json(v.conditions as never)}, ${sql.json(v.actions as never)})`;
  }
  return listAutomations(sql, clientId);
}
