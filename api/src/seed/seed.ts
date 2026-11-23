// Builds a visitor's sandbox: a fictional agency with four people, three clients, campaigns,
// about fifty leads with their conversations and history, automations with run logs, and a
// simulated GoHighLevel account with the leads that were synced.
//
// AI scores and drafts come from fixtures.json, produced by running the real model over these
// leads (scripts/build-seed.ts). Writes are queued and sent together so postgres.js can pipeline
// them on one connection.
import type { Sql } from '../db.js';
import { apiKey, ghlId } from '../lib/ids.js';
import { ghlStage } from '../ghl/sync.js';
import { modelName } from '../lib/text.js';
import { CAMPAIGNS, CLIENTS, LEADS, firstReply, type LeadDef } from './data.js';
import fixtures from './fixtures.json' with { type: 'json' };
import type { Action, Condition, LeadAnalysis, Stage } from '../../../shared/types.js';

const F = fixtures as unknown as {
  analyses: Record<string, LeadAnalysis>;
  drafts: Record<string, { channel: 'sms' | 'email'; subject: string; body: string; rationale: string; facts_used: string[]; model: string }>;
};

const PEOPLE = [
  { key: 'sam', name: 'Sam Okafor', email: 'sam@northlight.example', title: 'Head of Delivery', role: 'agency_admin', initials: 'SO', clients: [] as string[] },
  { key: 'priya', name: 'Priya Shah', email: 'priya@northlight.example', title: 'Account Manager', role: 'account_manager', initials: 'PS', clients: ['brightside', 'ridgeway'] },
  { key: 'jordan', name: 'Jordan Ellis', email: 'jordan@northlight.example', title: 'Account Manager', role: 'account_manager', initials: 'JE', clients: ['harbour'] },
  { key: 'tom', name: 'Tom Hughes', email: 'tom@harbourdental.example', title: 'Practice Manager, Harbour Dental (client)', role: 'client_viewer', initials: 'TH', clients: ['harbour'] },
] as const;

const OWNER: Record<string, string> = { brightside: 'priya', harbour: 'jordan', ridgeway: 'priya' };

function automationsFor(key: string, name: string): Array<{ name: string; trigger: string; delay: number; conditions: Condition[]; actions: Action[]; enabled: boolean }> {
  const channel = `#${key}-leads`;
  return [
    {
      name: 'Speed to lead: hot leads',
      trigger: 'lead.qualified',
      delay: 0,
      enabled: true,
      conditions: [{ field: 'priority', op: 'eq', value: 'high' }],
      actions: [
        { type: 'assign_owner', params: { strategy: 'round_robin' } },
        { type: 'draft_followup', params: { channel: key === 'ridgeway' ? 'email' : 'sms' } },
        { type: 'notify', params: { channel: 'slack', target: channel } },
        { type: 'sync_crm', params: {} },
      ],
    },
    {
      name: 'Qualified leads to GoHighLevel',
      trigger: 'lead.qualified',
      delay: 0,
      enabled: true,
      conditions: [{ field: 'priority', op: 'eq', value: 'medium' }],
      actions: [
        { type: 'assign_owner', params: { strategy: 'round_robin' } },
        { type: 'draft_followup', params: { channel: 'email' } },
        { type: 'sync_crm', params: {} },
      ],
    },
    {
      name: 'Nobody has replied in 15 minutes',
      trigger: 'no_reply',
      delay: 15,
      enabled: true,
      conditions: [{ field: 'priority', op: 'in', value: ['high', 'medium'] }],
      actions: [
        { type: 'add_tag', params: { tag: 'needs-attention' } },
        { type: 'notify', params: { channel: 'slack', target: channel } },
      ],
    },
    {
      name: 'Not a fit: tag and send to nurture',
      trigger: 'lead.qualified',
      delay: 0,
      enabled: true,
      conditions: [{ field: 'intent', op: 'in', value: ['not_a_fit', 'spam', 'early_research'] }],
      actions: [
        { type: 'add_tag', params: { tag: 'nurture' } },
        { type: 'webhook', params: { url: `https://hooks.example.com/${key}/nurture-list` } },
      ],
    },
    {
      name: `Won deals: tell the ${name} team`,
      trigger: 'stage.changed',
      delay: 0,
      enabled: true,
      conditions: [{ field: 'stage', op: 'eq', value: 'won' }],
      actions: [
        { type: 'notify', params: { channel: 'slack', target: `${channel}-wins` } },
        { type: 'sync_crm', params: {} },
      ],
    },
  ];
}

const STAGE_PATH: Record<Stage, Stage[]> = {
  new: [],
  contacted: ['contacted'],
  qualified: ['contacted', 'qualified'],
  booked: ['contacted', 'qualified', 'booked'],
  won: ['contacted', 'qualified', 'booked', 'won'],
  lost: ['contacted', 'lost'],
};

export async function seedAgency(tx: Sql, agencyId: string) {
  // Rows are collected per table and written with one multi-row insert each: a seed is about a
  // dozen round trips however many leads it has.
  const rows: Record<string, Record<string, unknown>[]> = {
    users: [], clients: [], memberships: [], automations: [], campaigns: [], leads: [], messages: [], activities: [],
    automation_runs: [], ghl_contacts: [], ghl_opportunities: [], sync_jobs: [], sync_attempts: [],
  };
  const add = (table: string, row: Record<string, unknown>) => rows[table].push(row);
  const now = Date.now();
  const uid = () => crypto.randomUUID();
  const iso = (ms: number) => new Date(ms).toISOString();

  // People
  const people: Record<string, string> = {};
  for (const p of PEOPLE) {
    people[p.key] = uid();
    add('users', { id: people[p.key], agency_id: agencyId, name: p.name, email: p.email, title: p.title, role: p.role, initials: p.initials });
  }

  // Clients, memberships, campaigns, automations
  const clientIds: Record<string, string> = {};
  const locations: Record<string, string> = {};
  const automationIds: Record<string, string[]> = {};
  for (const c of CLIENTS) {
    const id = (clientIds[c.key] = uid());
    locations[c.key] = 'loc_' + c.key + '_' + ghlId().slice(0, 8);
    add('clients', {
      id, agency_id: agencyId, slug: c.slug, name: c.name, industry: c.industry, location: c.location, brand_color: c.brand_color,
      offer: c.offer, ideal_customer: c.ideal_customer, criteria: tx.json(c.criteria as never), service_area: c.service_area,
      booking_link: c.booking_link, tone: c.tone, avg_deal_value: c.avg_deal_value, api_key: apiKey(), ghl_location_id: locations[c.key],
    });
    for (const p of PEOPLE) {
      if ((p.clients as readonly string[]).includes(c.key)) add('memberships', { user_id: people[p.key], client_id: id });
    }
    automationIds[c.key] = [];
    for (const [i, a] of automationsFor(c.key, c.name).entries()) {
      const aid = uid();
      automationIds[c.key].push(aid);
      add('automations', {
        id: aid, client_id: id, name: a.name, enabled: a.enabled, trigger: a.trigger, delay_minutes: a.delay,
        conditions: tx.json(a.conditions as never), actions: tx.json(a.actions as never), created_at: iso(now - 60 * 86400000 + i * 1000),
      });
    }
  }
  const campaignIds: Record<string, string> = {};
  for (const cp of CAMPAIGNS) {
    campaignIds[cp.key] = uid();
    add('campaigns', {
      id: campaignIds[cp.key], client_id: clientIds[cp.client], name: cp.name, source: cp.source, utm_campaign: cp.utm,
      status: cp.status ?? 'active', started_on: iso(now - cp.started_days_ago * 86400000).slice(0, 10), spend: cp.spend,
    });
  }

  // Leads
  LEADS.forEach((def: LeadDef, index) => {
    const cp = CAMPAIGNS.find((c) => c.key === def.campaign)!;
    const client = CLIENTS.find((c) => c.key === cp.client)!;
    const clientId = clientIds[client.key];
    const ownerKey = OWNER[client.key];
    const ownerName = PEOPLE.find((p) => p.key === ownerKey)!.name;
    const analysis = F.analyses[def.key] ?? null;

    // Arrival time: N days ago at the given hour (UK), never in the future.
    const day = new Date(now - def.days * 86400000);
    day.setUTCHours(def.hour, (index * 13) % 60, 0, 0);
    let created = day.getTime();
    if (created > now - 20 * 60000) created = now - (25 + index * 9) * 60000;

    const leadId = uid();
    const owner = def.stage === 'new' && !def.draft ? null : people[ownerKey];
    const value = def.value ?? (['booked', 'won', 'qualified'].includes(def.stage) ? client.avg_deal_value : null);
    const responded = def.reply != null ? created + def.reply * 60000 : null;
    const synced = analysis && analysis.priority !== 'low';
    const contactId = synced ? ghlId() : null;
    const oppId = synced ? ghlId() : null;
    const tags = analysis?.priority === 'low' ? ['nurture'] : [];

    add('leads', {
      id: leadId, client_id: clientId, campaign_id: campaignIds[def.campaign], source: cp.source, first_name: def.first, last_name: def.last,
      email: def.email ?? null, phone: def.phone ?? null, company: def.company ?? null, postcode: def.postcode,
      answers: tx.json(def.answers as never), message: def.message, stage: def.stage, owner_id: owner, value, tags,
      ai_status: analysis ? 'done' : 'pending', score: analysis?.score ?? null, priority: analysis?.priority ?? null,
      intent: analysis?.intent ?? null, analysis: analysis ? tx.json({ ...analysis, analysed_at: iso(created + 4000) } as never) : null,
      first_response_at: responded ? iso(responded) : null, last_activity_at: iso(responded ?? created),
      ghl_contact_id: contactId, ghl_opportunity_id: oppId, created_at: iso(created),
    });

    // Conversation
    const messages: Array<[string, string, string, string, string | null, string, string | null, string | null, string]> = [];
    messages.push(['inbound', 'form', 'received', 'form', null, def.message, null, null, iso(created)]);
    const act: Array<[number, string, string, string]> = [
      [created, 'system', 'created', `New lead from ${client.name}'s ${cp.name} campaign.`],
    ];
    if (analysis) {
      act.push([created + 4000, 'ai', 'qualified', `${modelName(analysis.model)} scored ${analysis.score}/100, ${analysis.priority} priority: ${analysis.summary}`]);
    }
    if (owner) act.push([created + 6000, 'automation', 'assigned', `Assigned to ${ownerName} (round robin).`]);
    if (responded) {
      const reply = firstReply(client, def, ownerName.split(' ')[0]);
      messages.push(['outbound', reply.channel, 'sent', reply.channel, reply.subject, reply.body, owner, owner, iso(responded)]);
      act.push([responded, ownerName, 'message_sent', `${ownerName} sent ${reply.channel === 'sms' ? 'an SMS' : 'an email'} (simulated delivery).`]);
      if (def.replied) {
        messages.push(['inbound', reply.channel, 'received', reply.channel, null, def.replied, null, null, iso(responded + 38 * 60000)]);
        act.push([responded + 38 * 60000, `${def.first} ${def.last}`.trim(), 'reply', `${def.first} replied.`]);
      }
    }
    let t = (responded ?? created) + 60000;
    for (const stage of STAGE_PATH[def.stage]) {
      t += (def.days > 2 ? 18 : 2) * 3600000 * (stage === 'contacted' ? 0.02 : 1);
      if (t > now) t = now - 60000;
      act.push([t, ownerName, 'stage_changed', `Moved to ${stage}.`]);
    }
    if (synced) act.push([created + 9000, 'system', 'crm_synced', 'Synced to GoHighLevel (simulated).']);

    const draft = F.drafts[def.key];
    if (draft) {
      messages.push([
        'outbound', draft.channel, 'draft', draft.channel, draft.channel === 'email' ? draft.subject : null, draft.body, null, null, iso(created + 7000),
      ]);
      act.push([created + 7000, 'automation', 'drafted', `${modelName(draft.model)} drafted ${draft.channel === 'sms' ? 'an SMS' : 'an email'} for review.`]);
    }

    for (const [direction, channel, status, , subject, body, createdBy, approvedBy, at] of messages) {
      const ai = status === 'draft' && draft ? { provider: 'anthropic', model: draft.model, rationale: draft.rationale, facts_used: draft.facts_used } : null;
      add('messages', {
        id: uid(), lead_id: leadId, direction, channel, status, subject, body, ai: ai ? tx.json(ai as never) : null,
        created_by: createdBy, approved_by: approvedBy, sent_at: status === 'sent' ? at : null, created_at: at,
      });
    }
    for (const [at, actor, kind, message] of act) {
      add('activities', { lead_id: leadId, client_id: clientId, at: iso(at), actor, kind, message });
    }

    // Automation history, matching what the rules above would have done.
    const [hot, medium, , nurture] = automationIds[client.key];
    const ran = analysis?.priority === 'high' ? hot : analysis?.priority === 'medium' ? medium : analysis ? nurture : null;
    if (ran) {
      const retried = index % 7 === 3; // a few runs show a CRM retry
      const steps =
        ran === nurture
          ? [
              { action: 'add_tag', status: 'succeeded', detail: 'Tagged "nurture".', ms: 41, attempts: 1 },
              { action: 'webhook', status: 'succeeded', detail: `Simulated: delivered 112 bytes to https://hooks.example.com/${client.key}/nurture-list${retried ? ' on attempt 2' : ''}.`, ms: retried ? 640 : 88, attempts: retried ? 2 : 1 },
            ]
          : [
              { action: 'assign_owner', status: 'succeeded', detail: `Assigned to ${ownerName} (round robin).`, ms: 38, attempts: 1 },
              { action: 'draft_followup', status: 'succeeded', detail: 'Drafted a follow-up with Claude. A person approved it before it was sent.', ms: 2400 + (index % 5) * 310, attempts: 1 },
              ...(ran === hot ? [{ action: 'notify', status: 'succeeded', detail: `Simulated: would post to Slack #${client.key}-leads.`, ms: 12, attempts: 1 }] : []),
              { action: 'sync_crm', status: 'succeeded', detail: retried ? 'Pushed to GoHighLevel (simulated CRM) after a rate-limit retry.' : 'Pushed to GoHighLevel (simulated CRM).', ms: retried ? 1830 : 520, attempts: retried ? 2 : 1 },
            ];
      const steps2 = draft && ran !== nurture ? steps.map((s) => (s.action === 'draft_followup' ? { ...s, detail: 'Drafted a follow-up with Claude. Waiting for a person to approve it.' } : s)) : steps;
      add('automation_runs', {
        id: uid(), automation_id: ran, lead_id: leadId, status: 'succeeded', steps: tx.json(steps2 as never),
        started_at: iso(created + 5000), finished_at: iso(created + 9000),
      });
      const runName = ran === hot ? 'Speed to lead: hot leads' : ran === medium ? 'Qualified leads to GoHighLevel' : 'Not a fit: tag and send to nurture';
      add('activities', { lead_id: leadId, client_id: clientId, at: iso(created + 9500), actor: 'automation', kind: 'automation_ran', message: `Automation "${runName}" ran ${steps2.length} steps.` });
    }

    // Simulated CRM state and the sync log that produced it.
    if (synced && contactId && oppId) {
      const target = ghlStage(client.slug, def.stage);
      add('ghl_contacts', {
        id: contactId, agency_id: agencyId, location_id: locations[client.key], first_name: def.first, last_name: def.last,
        email: def.email ?? null, phone: def.phone ?? null, source: 'LeadFlow: ' + cp.name, tags: ['priority-' + analysis!.priority],
        custom_fields: tx.json([] as never), created_at: iso(created + 9000), updated_at: iso(created + 9000),
      });
      add('ghl_opportunities', {
        id: oppId, agency_id: agencyId, location_id: locations[client.key], contact_id: contactId, pipeline_id: target.pipelineId,
        stage_id: target.pipelineStageId, name: `${def.first} ${def.last}`.trim() + ' – ' + client.name, status: target.status,
        monetary_value: value, created_at: iso(created + 9000), updated_at: iso(created + 9000),
      });
      const jobId = uid();
      const retried = index % 7 === 3;
      add('sync_jobs', { id: jobId, client_id: clientId, lead_id: leadId, state: 'succeeded', attempts: retried ? 2 : 1, created_at: iso(created + 8000), updated_at: iso(created + 9000) });
      const attempts: Array<[number, string, string, number | null, string, string, number]> = retried
        ? [
            [1, 'contact', 'POST /contacts/upsert', 429, 'retry', 'Too Many Requests: burst limit of 100 requests per 10 seconds reached', 210],
            [2, 'contact', 'POST /contacts/upsert', 201, 'ok', 'Created contact', 260],
            [2, 'opportunity', 'POST /opportunities/', 201, 'ok', `Created in stage ${def.stage}`, 240],
          ]
        : [
            [1, 'contact', 'POST /contacts/upsert', 201, 'ok', 'Created contact', 250],
            [1, 'opportunity', 'POST /opportunities/', 201, 'ok', 'Created in stage new', 230],
          ];
      attempts.forEach(([attempt, step, request, status, outcome, detail, ms], i) =>
        add('sync_attempts', { job_id: jobId, at: iso(created + 8000 + i * 400), attempt, step, request, status, outcome, detail, duration_ms: ms }),
      );
    }
  });

  // Parents before children. Sent together: queries on one connection run in the order sent,
  // so the foreign keys are satisfied, and the whole seed is about one round trip.
  await Promise.all(Object.keys(rows).filter((t) => rows[t].length).map((t) => tx`insert into ${tx(t)} ${tx(rows[t] as never)}`));
}
