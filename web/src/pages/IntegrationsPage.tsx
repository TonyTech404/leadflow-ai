import { useState } from 'react';
import { Link } from 'react-router';
import type { GhlMode, SyncJob } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { ago } from '../lib/format';
import { useSession } from '../session';
import { Loading, PageHeader, SimBadge, modelName } from '../components/ui';

interface Data {
  ghl_mode: GhlMode;
  jobs: SyncJob[];
  crm: { contacts: number; opportunities: number };
}

const MODES: { mode: GhlMode; title: string; body: string }[] = [
  { mode: 'healthy', title: 'Healthy', body: 'Every call works in about a quarter of a second.' },
  { mode: 'rate_limited', title: 'Rate limited', body: 'Almost half of calls get 429 Too Many Requests. Syncs back off and retry.' },
  { mode: 'outage', title: 'Partial outage', body: 'Some calls get 503, and some saves succeed but the reply is lost. Retries look before they create, so nothing is duplicated.' },
  { mode: 'token_expired', title: 'Token expired', body: 'GoHighLevel rotates the access token. The next call gets 401, refreshes the token, and carries on.' },
];

const OTHERS: { name: string; status: 'live' | 'simulated' | 'planned'; detail: string }[] = [
  { name: 'Claude API', status: 'live', detail: 'Lead scoring, follow-up drafts and campaign insights, with structured outputs and a rule-based fallback.' },
  { name: 'Website forms and lead API', status: 'live', detail: 'Public form per client and POST /api/v1/leads with a per-client key.' },
  { name: 'GoHighLevel webhooks (inbound)', status: 'live', detail: 'Signed, deduplicated endpoint. In the demo the sender is simulated from the lead page.' },
  { name: 'Email and SMS sending', status: 'simulated', detail: 'Approved messages are marked sent. A provider adapter (Postmark, Twilio, or GHL Conversations) slots in behind one function.' },
  { name: 'Slack alerts', status: 'simulated', detail: 'Automations record what they would post.' },
  { name: 'Meta Lead Ads', status: 'planned', detail: 'Adapter for the leadgen webhook, mapping form fields to answers. Not connected.' },
  { name: 'Google Ads lead forms', status: 'planned', detail: 'Lead form webhook into the same ingestion API. Not connected.' },
  { name: 'Ad spend (Meta and Google)', status: 'planned', detail: 'Daily spend import for real cost per qualified lead. Spend shown in the demo is sample data.' },
];

function JobRow({ job }: { job: SyncJob }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 px-4 py-2.5 text-left hover:bg-[#fafbfd] sm:grid-cols-[1fr_12rem_8rem_7rem]" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><Link to={`/leads/${job.lead_id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{job.lead_name}</Link></span>
        <span className="text-[13px] text-ink-3">{job.client_name}</span>
        <span className={`text-[13px] font-medium ${job.state === 'succeeded' ? 'text-good' : job.state === 'failed' ? 'text-bad' : 'text-warm'}`}>
          {job.state}{job.attempts > 1 ? `, ${job.attempts} tries` : ''}
        </span>
        <span className="text-right text-[12px] text-ink-3">{ago(job.updated_at)}</span>
      </button>
      {open && (
        <ol className="mx-4 mb-3 space-y-1 border-l border-line pl-3">
          {job.log.map((l, i) => (
            <li key={i} className="text-[12.5px]">
              <span className="num text-ink-3">#{l.attempt}</span> <span className="font-medium">{l.request}</span>{' '}
              <span className={['ok', 'found', 'refreshed'].includes(l.outcome) ? 'text-good' : l.outcome === 'fatal' ? 'text-bad' : 'text-warm'}>{l.status ?? 'timeout'} {l.outcome}</span>
              {l.detail && <span className="text-ink-3"> {l.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function IntegrationsPage() {
  const { session, refresh } = useSession();
  const data = useResource<Data>('/integrations', { pollMs: 6000, pollWhile: (d) => d.jobs.some((j) => j.state === 'retrying' || j.state === 'pending') });
  const [running, setRunning] = useState<string | null>(null);
  if (!data.data || !session) return <Loading />;

  return (
    <div className="max-w-[1080px] space-y-8">
      <PageHeader title="Integrations" sub="What is connected for real, what is simulated in this demo, and what is designed but not built yet." />

      <section className="panel" aria-labelledby="ghl-h">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 id="ghl-h" className="font-semibold">GoHighLevel</h2>
            <p className="text-[13px] text-ink-2">
              Contacts and opportunities pushed through an outbox with retries. The API is simulated, modelled on LeadConnector v2. {data.data.crm.contacts} contacts and{' '}
              {data.data.crm.opportunities} opportunities in this sandbox.
            </p>
          </div>
          <SimBadge>Simulated API</SimBadge>
        </div>
        <div className="px-4 py-4">
          <h3 className="text-[13px] font-semibold">Failure lab</h3>
          <p className="mt-0.5 text-[13px] text-ink-3">Make GoHighLevel misbehave, then submit a lead from a client's form and watch the sync log.</p>
          <fieldset className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="sr-only">GoHighLevel behaviour</legend>
            {MODES.map((m) => {
              const on = data.data!.ghl_mode === m.mode;
              return (
                <label key={m.mode} className={`cursor-pointer rounded-lg border p-3 ${on ? 'border-blue bg-blue-wash' : 'border-line hover:border-line-strong'}`}>
                  <input
                    type="radio"
                    name="mode"
                    className="sr-only"
                    checked={on}
                    onChange={async () => {
                      setRunning('mode');
                      await api('/integrations/ghl', { method: 'PUT', json: { mode: m.mode } });
                      await Promise.all([data.reload(), refresh()]);
                      setRunning(null);
                    }}
                  />
                  <span className="flex items-center gap-2 font-medium">
                    <span className={`size-3 rounded-full border-2 ${on ? 'border-blue bg-blue' : 'border-ink-3'}`} aria-hidden />
                    {m.title}
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-snug text-ink-2">{m.body}</span>
                </label>
              );
            })}
          </fieldset>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {session.clients.map((c) => (
              <a key={c.id} className="btn btn-quiet btn-sm" href={`/f/${c.slug}`} target="_blank" rel="noreferrer">{c.name} form</a>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              disabled={!!running}
              onClick={async () => {
                setRunning('run');
                await api('/integrations/run', { method: 'POST' });
                await data.reload();
                setRunning(null);
              }}
            >
              {running === 'run' ? 'Running…' : 'Run due retries now'}
            </button>
          </div>
        </div>
        <h3 className="border-t border-line px-4 pt-3 text-[13px] font-semibold">Recent syncs</h3>
        <ul className="mt-1 divide-y divide-line">
          {data.data.jobs.map((j) => <JobRow key={j.id} job={j} />)}
        </ul>
      </section>

      <section aria-labelledby="other-h">
        <h2 id="other-h" className="mb-3 text-[15px] font-semibold">Everything else</h2>
        <ul className="panel divide-y divide-line">
          {OTHERS.map((o) => (
            <li key={o.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_7rem_1fr] sm:items-baseline sm:gap-4">
              <span className="font-medium">{o.name === 'Claude API' && session.ai.live ? `Claude API (${modelName(session.ai.model)})` : o.name}</span>
              <span className={`text-[12.5px] font-medium ${o.status === 'live' ? 'text-good' : o.status === 'simulated' ? 'text-warm' : 'text-ink-3'}`}>
                {o.status === 'live' ? 'Live' : o.status === 'simulated' ? 'Simulated' : 'Not connected'}
              </span>
              <span className="text-[13px] text-ink-2">{o.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
