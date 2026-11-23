// Types shared by the API and the web app.

export type Role = 'agency_admin' | 'account_manager' | 'client_viewer';
export type Stage = 'new' | 'contacted' | 'qualified' | 'booked' | 'won' | 'lost';
export type Priority = 'high' | 'medium' | 'low';
export type Source = 'meta' | 'google' | 'tiktok' | 'linkedin' | 'email' | 'organic' | 'referral';
export type GhlMode = 'healthy' | 'rate_limited' | 'outage' | 'token_expired';

export const STAGES: Stage[] = ['new', 'contacted', 'qualified', 'booked', 'won', 'lost'];

export interface User {
  id: string;
  name: string;
  email: string;
  title: string;
  role: Role;
  initials: string;
  client_ids: string[];
}

export interface ClientSummary {
  id: string;
  slug: string;
  name: string;
  industry: string;
  location: string;
  brand_color: string;
}

export interface Client extends ClientSummary {
  offer: string;
  ideal_customer: string;
  criteria: string[];
  service_area: string[];
  booking_link: string;
  tone: string;
  avg_deal_value: number;
  currency: string;
  api_key?: string; // only for users who can manage the client
  ghl_location_id: string;
}

export interface Session {
  agency: { id: string; name: string; ghl_mode: GhlMode };
  user: User;
  users: User[];
  clients: ClientSummary[];
  can: { manage_agency: boolean; see_costs: boolean };
  ai: { provider: 'anthropic' | 'demo'; model: string; live: boolean };
}

/** Structured result of AI lead qualification. */
export interface LeadAnalysis {
  score: number;
  priority: Priority;
  intent: 'ready_to_buy' | 'comparing_options' | 'early_research' | 'not_a_fit' | 'spam';
  summary: string;
  facts: { label: string; value: string }[];
  reasons: { factor: string; impact: 'positive' | 'negative' | 'neutral'; detail: string }[];
  missing_info: string[];
  next_action: {
    type: 'call_now' | 'send_sms' | 'send_email' | 'book_meeting' | 'nurture' | 'disqualify';
    detail: string;
    within_hours: number;
  };
  confidence: number;
  provider: 'anthropic' | 'demo';
  model: string;
  ms: number;
  analysed_at: string;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: 'form' | 'email' | 'sms' | 'note';
  status: 'received' | 'draft' | 'sent' | 'rejected' | 'failed';
  subject: string | null;
  body: string;
  ai: { provider: 'anthropic' | 'demo'; model: string; rationale: string; facts_used: string[] } | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface Activity {
  id: number;
  at: string;
  actor: string;
  kind: string;
  message: string;
}

export interface LeadSummary {
  id: string;
  client_id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: Source;
  campaign_id: string | null;
  campaign_name: string | null;
  stage: Stage;
  score: number | null;
  priority: Priority | null;
  intent: string | null;
  ai_status: 'pending' | 'done' | 'failed';
  summary: string | null;
  owner_id: string | null;
  owner_name: string | null;
  value: number | null;
  tags: string[];
  has_draft: boolean;
  first_response_at: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface Lead extends LeadSummary {
  postcode: string | null;
  answers: Record<string, string>;
  message: string;
  analysis: LeadAnalysis | null;
  messages: Message[];
  activities: Activity[];
  runs: AutomationRun[];
  sync: SyncJob | null;
  ghl_contact_id: string | null;
  ghl_opportunity_id: string | null;
  client: Client;
}

export interface Campaign {
  id: string;
  name: string;
  source: Source;
  utm_campaign: string;
  status: 'active' | 'paused' | 'ended';
  started_on: string;
  spend: number;
}

export type AutomationTrigger = 'lead.created' | 'lead.qualified' | 'stage.changed' | 'no_reply';

export interface Condition {
  field: 'priority' | 'score' | 'intent' | 'source' | 'stage' | 'tag';
  op: 'eq' | 'neq' | 'gte' | 'lte' | 'in' | 'has';
  value: string | number | string[];
}

export type ActionType =
  | 'assign_owner'
  | 'draft_followup'
  | 'add_tag'
  | 'move_stage'
  | 'notify'
  | 'sync_crm'
  | 'webhook';

export interface Action {
  type: ActionType;
  params: Record<string, string | number | boolean>;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  delay_minutes: number;
  conditions: Condition[];
  actions: Action[];
  runs_total: number;
  runs_failed: number;
  last_run_at: string | null;
}

export interface AutomationStep {
  action: ActionType;
  status: 'succeeded' | 'failed' | 'skipped';
  detail: string;
  ms: number;
  attempts: number;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  automation_name: string;
  lead_id: string;
  lead_name: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  steps: AutomationStep[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SyncAttempt {
  at: string;
  attempt: number;
  step: string;
  request: string;
  status: number | null;
  outcome: 'ok' | 'retry' | 'uncertain' | 'fatal' | 'found' | 'refreshed';
  detail: string | null;
  duration_ms: number;
}

export interface SyncJob {
  id: string;
  lead_id: string;
  lead_name: string;
  client_name: string;
  state: 'pending' | 'retrying' | 'succeeded' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  updated_at: string;
  log: SyncAttempt[];
}

export interface CampaignStats {
  campaign_id: string | null;
  name: string;
  source: Source;
  leads: number;
  qualified: number;   // high or medium priority
  high: number;
  booked: number;
  won: number;
  spend: number;
  cost_per_lead: number | null;
  cost_per_qualified: number | null;
  median_response_minutes: number | null;
  avg_score: number | null;
}

export interface Analytics {
  days: number;
  totals: {
    leads: number;
    qualified: number;
    qualified_rate: number | null;
    booked: number;
    won: number;
    pipeline_value: number;
    won_value: number;
    spend: number;
    cost_per_qualified: number | null;
    median_response_minutes: number | null;
    responded_within_5_min: number | null; // share of leads answered within 5 minutes
  };
  daily: { date: string; leads: number; qualified: number }[];
  campaigns: CampaignStats[];
  sources: { source: Source; leads: number; qualified: number }[];
  funnel: { stage: Stage; count: number }[];
}

export interface Insights {
  headline: string;
  items: { title: string; detail: string; action: string }[];
  provider: 'anthropic' | 'demo';
  model: string;
  generated_at: string;
}

export interface ClientOverview {
  client: ClientSummary;
  leads_7d: number;
  leads_prev_7d: number;
  high_open: number;
  awaiting_reply: number;
  median_response_minutes: number | null;
  qualified_rate: number | null;
  pipeline_value: number;
}
