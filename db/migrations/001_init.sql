-- LeadFlow AI schema.
--
-- Tenancy: an agency owns client workspaces; every lead-level row hangs off a client, and every
-- query is scoped by client after a permission check. In the public demo each visitor gets their
-- own agency (a sandbox), so nobody sees anyone else's edits.

create extension if not exists pgcrypto;

-- ── Agency, people, clients ─────────────────────────────────────────────────

create table agencies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- How the simulated GoHighLevel API behaves for this sandbox (the "failure lab").
  ghl_mode     text not null default 'healthy'
               check (ghl_mode in ('healthy', 'rate_limited', 'outage', 'token_expired')),
  ghl_token_version int not null default 1,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table users (
  id           uuid primary key default gen_random_uuid(),
  agency_id    uuid not null references agencies on delete cascade,
  name         text not null,
  email        text not null,
  title        text not null,
  role         text not null check (role in ('agency_admin', 'account_manager', 'client_viewer')),
  initials     text not null,
  created_at   timestamptz not null default now()
);

create table clients (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references agencies on delete cascade,
  slug            text not null,
  name            text not null,
  industry        text not null,
  location        text not null,
  brand_color     text not null,
  offer           text not null,          -- what the client sells, for the AI
  ideal_customer  text not null,          -- who a good lead is, for the AI
  criteria        jsonb not null,         -- qualification criteria, for the AI and the UI
  service_area    text[] not null,        -- postcode areas the client serves
  booking_link    text not null,
  tone            text not null,          -- brand voice for drafted messages
  avg_deal_value  numeric(12,2) not null,
  currency        text not null default 'GBP',
  api_key         text not null unique,   -- for POST /api/v1/leads
  ghl_location_id text not null,
  created_at      timestamptz not null default now(),
  unique (agency_id, slug)
);

-- Which clients an account manager or client viewer may see. Agency admins see all.
create table memberships (
  user_id   uuid not null references users on delete cascade,
  client_id uuid not null references clients on delete cascade,
  primary key (user_id, client_id)
);

-- ── Campaigns and leads ─────────────────────────────────────────────────────

create table campaigns (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients on delete cascade,
  name         text not null,
  source       text not null check (source in ('meta', 'google', 'tiktok', 'linkedin', 'email', 'organic', 'referral')),
  utm_campaign text not null,
  status       text not null default 'active' check (status in ('active', 'paused', 'ended')),
  started_on   date not null,
  spend        numeric(12,2) not null default 0,  -- demo figure, labelled as such in the UI
  created_at   timestamptz not null default now()
);
create index campaigns_client on campaigns (client_id);

create table leads (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients on delete cascade,
  campaign_id        uuid references campaigns on delete set null,
  source             text not null,
  first_name         text not null,
  last_name          text not null default '',
  email              text,
  phone              text,
  company            text,
  postcode           text,
  answers            jsonb not null default '{}',   -- form fields, as submitted
  message            text not null default '',
  stage              text not null default 'new'
                     check (stage in ('new', 'contacted', 'qualified', 'booked', 'won', 'lost')),
  owner_id           uuid references users on delete set null,
  value              numeric(12,2),                 -- expected deal value
  tags               text[] not null default '{}',
  -- AI qualification
  ai_status          text not null default 'pending' check (ai_status in ('pending', 'done', 'failed')),
  score              int check (score between 0 and 100),
  priority           text check (priority in ('high', 'medium', 'low')),
  intent             text,
  analysis           jsonb,                         -- full structured result, with provider and model
  -- Speed to lead
  first_response_at  timestamptz,
  last_activity_at   timestamptz not null default now(),
  -- CRM link
  ghl_contact_id     text,
  ghl_opportunity_id text,
  created_at         timestamptz not null default now()
);
create index leads_client_created on leads (client_id, created_at desc);
create index leads_client_stage on leads (client_id, stage);
create index leads_campaign on leads (campaign_id);

-- Conversation: inbound form and replies, outbound follow-ups (drafts until a person approves).
create table messages (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads on delete cascade,
  direction    text not null check (direction in ('inbound', 'outbound')),
  channel      text not null check (channel in ('form', 'email', 'sms', 'note')),
  status       text not null check (status in ('received', 'draft', 'sent', 'rejected', 'failed')),
  subject      text,
  body         text not null,
  ai           jsonb,                    -- for AI drafts: provider, model, rationale, facts used
  created_by   uuid references users on delete set null,
  approved_by  uuid references users on delete set null,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index messages_lead on messages (lead_id, created_at);

create table activities (
  id         bigserial primary key,
  lead_id    uuid not null references leads on delete cascade,
  client_id  uuid not null references clients on delete cascade,
  at         timestamptz not null default now(),
  actor      text not null,             -- 'ai', 'system', 'automation', or a user's name
  kind       text not null,
  message    text not null,
  data       jsonb
);
create index activities_lead on activities (lead_id, at);
create index activities_client on activities (client_id, at desc);

-- ── Automations ─────────────────────────────────────────────────────────────

create table automations (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients on delete cascade,
  name          text not null,
  enabled       boolean not null default true,
  trigger       text not null check (trigger in ('lead.created', 'lead.qualified', 'stage.changed', 'no_reply')),
  delay_minutes int not null default 0,          -- for no_reply: minutes without a response
  conditions    jsonb not null default '[]',     -- [{ field, op, value }], all must match
  actions       jsonb not null,                  -- [{ type, params }], run in order
  created_at    timestamptz not null default now()
);

create table automation_runs (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations on delete cascade,
  lead_id       uuid not null references leads on delete cascade,
  status        text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  steps         jsonb not null default '[]',     -- [{ action, status, detail, ms, attempts }]
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  unique (automation_id, lead_id)                -- an automation runs once per lead
);
create index automation_runs_lead on automation_runs (lead_id);

-- ── CRM sync (outbox) ───────────────────────────────────────────────────────

create table sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients on delete cascade,
  lead_id         uuid not null references leads on delete cascade,
  provider        text not null default 'ghl',
  state           text not null default 'pending' check (state in ('pending', 'retrying', 'succeeded', 'failed')),
  attempts        int not null default 0,
  uncertain       boolean not null default false,  -- an earlier attempt may have reached the CRM
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index sync_jobs_due on sync_jobs (state, next_attempt_at);
create index sync_jobs_lead on sync_jobs (lead_id);

create table sync_attempts (
  id          bigserial primary key,
  job_id      uuid not null references sync_jobs on delete cascade,
  at          timestamptz not null default now(),
  attempt     int not null,
  step        text not null,
  request     text not null,
  status      int,
  outcome     text not null,     -- ok | retry | uncertain | fatal | found | refreshed
  detail      text,
  duration_ms int not null
);

-- Inbound webhooks, deduplicated by the sender's event id.
create table webhook_events (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null references agencies on delete cascade,
  provider    text not null,
  event_id    text not null,
  type        text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  unique (agency_id, provider, event_id)
);

-- ── Simulated GoHighLevel data store ───────────────────────────────────────
-- Stands in for a GHL sub-account. api/src/ghl/mock.ts serves the LeadConnector v2 shapes over it.

create table ghl_contacts (
  id            text primary key,
  agency_id     uuid not null references agencies on delete cascade,
  location_id   text not null,
  first_name    text,
  last_name     text,
  email         text,
  phone         text,
  source        text,
  tags          text[] not null default '{}',
  custom_fields jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ghl_contacts_lookup on ghl_contacts (location_id, email);

create table ghl_opportunities (
  id              text primary key,
  agency_id       uuid not null references agencies on delete cascade,
  location_id     text not null,
  contact_id      text not null references ghl_contacts on delete cascade,
  pipeline_id     text not null,
  stage_id        text not null,
  name            text not null,
  status          text not null default 'open' check (status in ('open', 'won', 'lost', 'abandoned')),
  monetary_value  numeric(12,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index ghl_opportunities_contact on ghl_opportunities (location_id, contact_id);

-- ── Cost and abuse controls ─────────────────────────────────────────────────

create table ai_usage (
  id            bigserial primary key,
  agency_id     uuid references agencies on delete set null,
  at            timestamptz not null default now(),
  task          text not null,
  provider      text not null,
  model         text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  ms            int not null,
  ok            boolean not null
);
create index ai_usage_at on ai_usage (at);

create table rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);
