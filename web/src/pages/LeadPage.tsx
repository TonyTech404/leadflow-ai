import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { STAGES, type Lead, type Message, type Stage } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { dateTime, INTENT_LABEL, money, SOURCE_LABEL, STAGE_LABEL } from '../lib/format';
import { useCanWrite, useSession } from '../session';
import { ErrorNote, Loading, ProviderBadge, ScoreBadge, SimBadge, WaitClock } from '../components/ui';

const ACTION_LABEL: Record<string, string> = {
  call_now: 'Call now', send_sms: 'Send an SMS', send_email: 'Send an email', book_meeting: 'Book a meeting', nurture: 'Add to nurture', disqualify: 'Disqualify',
};

function Analysis({ lead, onRerun, busy, canWrite }: { lead: Lead; onRerun: () => void; busy: boolean; canWrite: boolean }) {
  const a = lead.analysis;
  if (lead.ai_status === 'pending' || !a) {
    return (
      <section className="panel p-4" aria-label="AI analysis">
        <p className="flex items-center gap-2 font-medium">
          <span className="size-2 animate-pulse rounded-full bg-blue" aria-hidden />
          Claude is reading this enquiry…
        </p>
        <p className="mt-1 text-[13px] text-ink-3">Scoring against {lead.client.name}'s criteria. Usually 2 to 5 seconds.</p>
      </section>
    );
  }
  const due = new Date(new Date(a.analysed_at).getTime() + a.next_action.within_hours * 3600000);
  return (
    <section className="panel" aria-labelledby="ai-h">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 id="ai-h" className="text-[13px] font-semibold text-ink-2">AI qualification</h2>
          <p className="mt-1 flex items-baseline gap-2.5">
            <span className="num text-[34px] font-semibold leading-none tracking-[-0.02em]">{a.score}</span>
            <span className="text-ink-3">/ 100</span>
            <ScoreBadge score={a.score} priority={a.priority} />
          </p>
          <p className="mt-1 text-[13px] text-ink-2">
            {INTENT_LABEL[a.intent]}<span className="text-ink-3">, {Math.round(a.confidence * 100)}% confident</span>
          </p>
        </div>
        <ProviderBadge provider={a.provider} model={a.model} />
      </div>
      <div className="space-y-4 px-4 py-3">
        <p className="leading-relaxed">{a.summary}</p>

        <div className="rounded-lg border border-blue/25 bg-blue-wash px-3 py-2.5">
          <p className="text-[12px] font-semibold text-blue">
            Next: {ACTION_LABEL[a.next_action.type]}
            {a.next_action.within_hours <= 24 && (
              <span className="font-normal text-ink-2"> by {due.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{due.toDateString() !== new Date().toDateString() ? ` ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
            )}
          </p>
          <p className="mt-0.5 text-[13px] leading-snug">{a.next_action.detail}</p>
        </div>

        <div>
          <h3 className="mb-1.5 text-[12px] font-semibold text-ink-3">Why this score</h3>
          <ul className="space-y-1.5">
            {a.reasons.map((r, i) => (
              <li key={i} className="grid grid-cols-[1rem_1fr] gap-2 text-[13px] leading-snug">
                <span className={`mt-0.5 font-bold ${r.impact === 'positive' ? 'text-good' : r.impact === 'negative' ? 'text-hot' : 'text-ink-3'}`} aria-label={r.impact}>
                  {r.impact === 'positive' ? '+' : r.impact === 'negative' ? '−' : '•'}
                </span>
                <span>
                  <span className="font-medium">{r.factor}.</span> <span className="text-ink-2">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {!!a.facts.length && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            {a.facts.map((f, i) => (
              <div key={i} className="contents">
                <dt className="text-ink-3">{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {!!a.missing_info.length && (
          <div>
            <h3 className="mb-1 text-[12px] font-semibold text-ink-3">Still to find out</h3>
            <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-ink-2">
              {a.missing_info.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}
        {canWrite && (
          <button className="btn btn-ghost btn-sm -ml-2" onClick={onRerun} disabled={busy}>
            {busy ? 'Re-scoring…' : 'Score again'}
          </button>
        )}
      </div>
    </section>
  );
}

function Bubble({ m, lead }: { m: Message; lead: Lead }) {
  const inbound = m.direction === 'inbound';
  if (m.channel === 'note') {
    return (
      <li className="rounded-lg border border-dashed border-line-strong bg-[#fffdf5] px-3 py-2 text-[13px]">
        <p className="text-[12px] text-ink-3">Note by {m.created_by_name ?? 'someone'}, {dateTime(m.created_at)}</p>
        <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
      </li>
    );
  }
  return (
    <li className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 ${inbound ? 'border border-line bg-white' : 'bg-navy text-white'}`}>
        <p className={`mb-1 text-[11.5px] ${inbound ? 'text-ink-3' : 'text-white/70'}`}>
          {inbound ? (m.channel === 'form' ? 'Website form' : `${m.channel === 'sms' ? 'SMS' : 'Email'} from ${lead.first_name}`) : `${m.channel === 'sms' ? 'SMS' : 'Email'} sent${m.approved_by_name ? ` by ${m.approved_by_name}` : ''}`}
          {', '}
          {dateTime(m.sent_at ?? m.created_at)}
        </p>
        {m.subject && <p className="mb-1 font-semibold">{m.subject}</p>}
        <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
        {m.channel === 'form' && Object.keys(lead.answers).length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-line pt-2 text-[12.5px]">
            {Object.entries(lead.answers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function DraftCard({ m, onChange, canWrite }: { m: Message; onChange: (l: Lead) => void; canWrite: boolean }) {
  const [body, setBody] = useState(m.body);
  const [subject, setSubject] = useState(m.subject ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBody(m.body);
    setSubject(m.subject ?? '');
  }, [m.id, m.body, m.subject]);
  const dirty = body !== m.body || subject !== (m.subject ?? '');

  async function act(what: 'approve' | 'reject') {
    setBusy(what);
    setError(null);
    try {
      if (dirty) await api(`/messages/${m.id}`, { method: 'PATCH', json: { body, subject } });
      onChange(await api<Lead>(`/messages/${m.id}/${what}`, { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border-2 border-blue/40 bg-white p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-semibold">Draft {m.channel === 'sms' ? 'SMS' : 'email'} waiting for approval</p>
        {m.ai && <ProviderBadge provider={m.ai.provider} model={m.ai.model} />}
      </div>
      {m.ai?.rationale && <p className="mb-2 text-[12.5px] text-ink-2">{m.ai.rationale}</p>}
      {m.channel === 'email' && (
        <input className="field mb-2" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canWrite} aria-label="Subject" />
      )}
      <textarea className="field num" rows={m.channel === 'sms' ? 3 : 7} value={body} onChange={(e) => setBody(e.target.value)} disabled={!canWrite} aria-label="Message" />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3">
        <span>{m.ai?.facts_used.length ? `Uses: ${m.ai.facts_used.join('; ')}` : ''}</span>
        {m.channel === 'sms' && <span className={`num ${body.length > 320 ? 'text-hot' : ''}`}>{body.length} characters</span>}
      </div>
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => act('approve')} disabled={!!busy || !body.trim()}>
            {busy === 'approve' ? 'Sending…' : 'Approve and send'}
          </button>
          <button className="btn btn-ghost" onClick={() => act('reject')} disabled={!!busy}>
            Discard
          </button>
          <span className="self-center text-[12px] text-ink-3">Sending is simulated in the demo.</span>
        </div>
      )}
    </div>
  );
}

function Composer({ lead, onChange }: { lead: Lead; onChange: (l: Lead) => void }) {
  const [channel, setChannel] = useState<'sms' | 'email'>(lead.phone ? 'sms' : 'email');
  const [instruction, setInstruction] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(what: string, fn: () => Promise<Lead>) {
    setBusy(what);
    setError(null);
    try {
      onChange(await fn());
      if (what === 'note') setNote('');
      if (what === 'draft') setInstruction('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel space-y-3 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-line-strong p-0.5" role="radiogroup" aria-label="Channel">
          {(['sms', 'email'] as const).map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={channel === c}
              disabled={c === 'sms' ? !lead.phone : !lead.email}
              onClick={() => setChannel(c)}
              className={`rounded px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-40 ${channel === c ? 'bg-navy text-white' : 'text-ink-2'}`}
            >
              {c === 'sms' ? 'SMS' : 'Email'}
            </button>
          ))}
        </div>
        <input
          className="field min-w-48 flex-1"
          placeholder="Optional: tell the AI what to cover, e.g. offer Thursday 2pm"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          aria-label="Instruction for the AI"
        />
        <button className="btn btn-primary" disabled={!!busy} onClick={() => run('draft', () => api<Lead>(`/leads/${lead.id}/draft`, { method: 'POST', json: { channel, instruction } }))}>
          {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
        </button>
      </div>
      <div className="flex gap-2">
        <input className="field flex-1" placeholder="Add an internal note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <button className="btn btn-quiet" disabled={!!busy || !note.trim()} onClick={() => run('note', () => api<Lead>(`/leads/${lead.id}/notes`, { method: 'POST', json: { body: note } }))}>
          Add note
        </button>
      </div>
      {lead.ghl_contact_id && (
        <button
          className="btn btn-ghost btn-sm -ml-2"
          disabled={!!busy}
          onClick={() => run('reply', () => api<Lead>(`/leads/${lead.id}/simulate-reply`, { method: 'POST', json: {} }))}
          title="Sends a signed GoHighLevel-style InboundMessage webhook for this lead"
        >
          {busy === 'reply' ? 'Receiving reply and drafting an answer…' : `Simulate a reply from ${lead.first_name} (via GoHighLevel webhook)`}
        </button>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function CrmCard({ lead, onChange, canWrite }: { lead: Lead; onChange: (l: Lead) => void; canWrite: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = lead.sync;
  return (
    <section className="panel" aria-labelledby="crm-h">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 id="crm-h" className="text-[13px] font-semibold text-ink-2">GoHighLevel</h2>
        <SimBadge>Simulated CRM</SimBadge>
      </div>
      <div className="space-y-2 px-4 py-3 text-[13px]">
        {lead.ghl_opportunity_id ? (
          <p>
            Contact <code className="text-[12px]">{lead.ghl_contact_id}</code>, opportunity <code className="text-[12px]">{lead.ghl_opportunity_id}</code> in stage{' '}
            <span className="font-medium">{STAGE_LABEL[lead.stage]}</span>.
          </p>
        ) : (
          <p className="text-ink-2">Not in the CRM yet. Hot and warm leads are pushed automatically.</p>
        )}
        {job && (
          <details>
            <summary className="cursor-pointer text-ink-2">
              Sync {job.state === 'succeeded' ? 'succeeded' : job.state}
              {job.attempts > 1 ? ` after ${job.attempts} attempts` : ''}. Show the calls.
            </summary>
            <ol className="mt-2 space-y-1.5 border-l border-line pl-3">
              {job.log.map((l, i) => (
                <li key={i} className="text-[12px]">
                  <span className="num text-ink-3">#{l.attempt}</span>{' '}
                  <span className="font-medium">{l.request}</span>{' '}
                  <span className={l.outcome === 'ok' || l.outcome === 'found' || l.outcome === 'refreshed' ? 'text-good' : l.outcome === 'fatal' ? 'text-bad' : 'text-warm'}>
                    {l.status ?? 'timeout'} {l.outcome}
                  </span>
                  {l.detail && <span className="block text-ink-3">{l.detail}</span>}
                </li>
              ))}
            </ol>
          </details>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {canWrite && (
          <button
            className="btn btn-quiet btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onChange(await api<Lead>(`/leads/${lead.id}/sync`, { method: 'POST' }));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Syncing…' : lead.ghl_opportunity_id ? 'Sync again' : 'Push to GoHighLevel'}
          </button>
        )}
      </div>
    </section>
  );
}

export function LeadPage() {
  const { id } = useParams();
  const { session } = useSession();
  const canWrite = useCanWrite();
  const lead = useResource<Lead>(`/leads/${id}`, {
    pollMs: 3000,
    pollWhile: (l) => l.ai_status === 'pending' || l.runs.some((r) => r.status === 'running') || l.sync?.state === 'retrying',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (lead.error) return <p className="py-20 text-center text-ink-2">{lead.error}. <Link to="/" className="underline">Back to the overview</Link></p>;
  if (!lead.data || !session) return <Loading />;
  const l = lead.data;
  const draft = l.messages.find((m) => m.status === 'draft');
  const thread = l.messages.filter((m) => m.status !== 'draft' && m.status !== 'rejected');

  async function patch(body: Record<string, unknown>) {
    setError(null);
    try {
      lead.set(await api<Lead>(`/leads/${l.id}`, { method: 'PATCH', json: body }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const owners = session.users.filter((u) => u.role !== 'client_viewer');

  return (
    <div className="max-w-[1320px]">
      <Link to={`/c/${l.client_id}/pipeline`} className="text-[13px] text-ink-3 hover:text-ink">
        {l.client.name} pipeline
      </Link>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em]">
            {l.first_name} {l.last_name}
            {l.company && <span className="font-normal text-ink-3">, {l.company}</span>}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
            {l.phone && <span className="num">{l.phone}</span>}
            {l.email && <span>{l.email}</span>}
            {l.postcode && <span className="num">{l.postcode}</span>}
            <span className="text-ink-3">
              {l.campaign_name ?? SOURCE_LABEL[l.source]} ({SOURCE_LABEL[l.source]}), {dateTime(l.created_at)}
            </span>
            <WaitClock createdAt={l.created_at} respondedAt={l.first_response_at} />
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="label">Stage</span>
            <select className="field w-36" value={l.stage} disabled={!canWrite} onChange={(e) => patch({ stage: e.target.value as Stage })}>
              {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="label">Owner</span>
            <select className="field w-40" value={l.owner_id ?? ''} disabled={!canWrite} onChange={(e) => patch({ owner_id: e.target.value || null })}>
              <option value="">Unassigned</option>
              {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="label">Deal value</span>
            <input
              className="field num w-32"
              defaultValue={l.value ?? ''}
              key={l.value ?? 'none'}
              disabled={!canWrite}
              inputMode="numeric"
              placeholder={money(l.client.avg_deal_value)}
              onBlur={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '');
                const n = v ? Number(v) : null;
                if (n !== l.value) void patch({ value: n });
              }}
            />
          </label>
        </div>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <section aria-label="Conversation" className="space-y-3">
            <ol className="space-y-3">
              {thread.map((m) => <Bubble key={m.id} m={m} lead={l} />)}
            </ol>
            {draft && <DraftCard m={draft} onChange={lead.set} canWrite={canWrite} />}
            {canWrite ? <Composer lead={l} onChange={lead.set} /> : <p className="text-[13px] text-ink-3">You can read this conversation. Account managers reply from here.</p>}
          </section>

          <section aria-labelledby="act-h">
            <h2 id="act-h" className="mb-2 text-[13px] font-semibold text-ink-2">Activity</h2>
            <ol className="space-y-1.5 border-l border-line pl-4">
              {l.activities.map((a) => (
                <li key={a.id} className="relative text-[13px]">
                  <span className="absolute -left-[21px] top-1.5 size-2 rounded-full border-2 border-white bg-line-strong" aria-hidden />
                  <span className="num mr-2 text-[12px] text-ink-3">{dateTime(a.at)}</span>
                  <span className="text-ink-2">{a.message}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <Analysis
            lead={l}
            canWrite={canWrite}
            busy={busy}
            onRerun={async () => {
              setBusy(true);
              try {
                lead.set(await api<Lead>(`/leads/${l.id}/qualify`, { method: 'POST' }));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <CrmCard lead={l} onChange={lead.set} canWrite={canWrite} />
          {!!l.runs.length && (
            <section className="panel" aria-labelledby="runs-h">
              <h2 id="runs-h" className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink-2">Automations that ran</h2>
              <ul className="divide-y divide-line">
                {l.runs.map((r) => (
                  <li key={r.id} className="px-4 py-2.5 text-[13px]">
                    <p className="font-medium">
                      {r.automation_name}{' '}
                      <span className={r.status === 'succeeded' ? 'text-good' : r.status === 'failed' ? 'text-bad' : 'text-ink-3'}>{r.status === 'running' ? 'running…' : r.status}</span>
                    </p>
                    <ol className="mt-1 space-y-0.5">
                      {r.steps.map((s, i) => (
                        <li key={i} className="text-[12px] text-ink-2">
                          <span className={s.status === 'succeeded' ? 'text-good' : s.status === 'failed' ? 'text-bad' : 'text-ink-3'}>{s.status === 'succeeded' ? '✓' : s.status === 'failed' ? '✕' : '–'}</span>{' '}
                          {s.detail}
                          {s.attempts > 1 && <span className="text-ink-3"> ({s.attempts} attempts)</span>}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
