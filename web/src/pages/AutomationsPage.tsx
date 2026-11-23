import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Action, ActionType, Automation, AutomationRun, AutomationTrigger, Client, Condition } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { ago, STAGE_LABEL } from '../lib/format';
import { useCanWrite } from '../session';
import { ErrorNote, Loading, PageHeader } from '../components/ui';

const TRIGGER: Record<AutomationTrigger, string> = {
  'lead.created': 'When a lead arrives',
  'lead.qualified': 'When the AI has scored a lead',
  'stage.changed': 'When a lead changes stage',
  no_reply: 'When nobody has replied',
};

const FIELD: Record<Condition['field'], string> = { priority: 'priority', score: 'score', intent: 'intent', source: 'source', stage: 'stage', tag: 'tags' };
const VALUE_LABEL: Record<string, string> = { high: 'hot', medium: 'warm', low: 'cold', not_a_fit: 'not a fit', early_research: 'early research', ready_to_buy: 'ready to buy', comparing_options: 'comparing options', spam: 'spam' };
const OP: Record<Condition['op'], string> = { eq: 'is', neq: 'is not', gte: 'is at least', lte: 'is at most', in: 'is one of', has: 'include' };

const ACTION: Record<ActionType, string> = {
  assign_owner: 'Assign an owner',
  draft_followup: 'Draft a follow-up for approval',
  add_tag: 'Add a tag',
  move_stage: 'Move to a stage',
  notify: 'Post to Slack (simulated)',
  sync_crm: 'Push to GoHighLevel (simulated)',
  webhook: 'Send a webhook (simulated)',
};

const v = (x: string | number) => VALUE_LABEL[String(x)] ?? STAGE_LABEL[String(x)] ?? String(x);

function describeCondition(c: Condition) {
  const value = Array.isArray(c.value) ? c.value.map(v).join(', ') : v(c.value);
  return `${FIELD[c.field]} ${OP[c.op]} ${value}`;
}

function describeAction(a: Action) {
  switch (a.type) {
    case 'assign_owner': return 'assign an owner (round robin)';
    case 'draft_followup': return `draft ${a.params.channel === 'email' ? 'an email' : 'an SMS'} for a person to approve`;
    case 'add_tag': return `tag it "${a.params.tag}"`;
    case 'move_stage': return `move it to ${STAGE_LABEL[String(a.params.stage)]}`;
    case 'notify': return `post to Slack ${a.params.target} (simulated)`;
    case 'sync_crm': return 'push it to GoHighLevel';
    case 'webhook': return `send a webhook to ${a.params.url} (simulated)`;
  }
}

function Sentence({ a }: { a: Automation }) {
  return (
    <p className="leading-relaxed">
      <span className="font-medium">{TRIGGER[a.trigger]}{a.trigger === 'no_reply' ? ` for ${a.delay_minutes} minutes` : ''}</span>
      {a.conditions.length ? <>, if {a.conditions.map(describeCondition).join(' and ')}</> : ''}: {a.actions.map(describeAction).join(', then ')}.
    </p>
  );
}

const blank = (): Partial<Automation> => ({ name: '', trigger: 'lead.qualified', delay_minutes: 0, conditions: [{ field: 'priority', op: 'eq', value: 'high' }], actions: [{ type: 'sync_crm', params: {} }], enabled: true });

function Editor({ initial, clientId, onDone }: { initial: Partial<Automation>; clientId: string; onDone: (list?: Automation[]) => void }) {
  const [a, setA] = useState<Partial<Automation>>(structuredClone(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (patch: Partial<Automation>) => setA((x) => ({ ...x, ...patch }));
  const setCond = (i: number, patch: Partial<Condition>) => up({ conditions: a.conditions!.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAct = (i: number, patch: Partial<Action>) => up({ actions: a.actions!.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <div className="panel space-y-4 border-blue/40 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_16rem_8rem]">
        <label className="grid gap-1"><span className="label">Name</span><input className="field" value={a.name} onChange={(e) => up({ name: e.target.value })} /></label>
        <label className="grid gap-1">
          <span className="label">Trigger</span>
          <select className="field" value={a.trigger} onChange={(e) => up({ trigger: e.target.value as AutomationTrigger, delay_minutes: e.target.value === 'no_reply' ? 15 : 0 })}>
            {Object.entries(TRIGGER).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
        {a.trigger === 'no_reply' && (
          <label className="grid gap-1"><span className="label">After (minutes)</span><input className="field num" type="number" min={1} value={a.delay_minutes} onChange={(e) => up({ delay_minutes: Number(e.target.value) })} /></label>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="label mb-1">Only if all of these are true</legend>
        {a.conditions!.map((c, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <select className="field w-32" value={c.field} onChange={(e) => setCond(i, { field: e.target.value as Condition['field'] })}>
              {Object.entries(FIELD).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
            <select className="field w-32" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition['op'], value: e.target.value === 'in' ? [] : '' })}>
              {Object.entries(OP).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
            <input
              className="field w-64"
              value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}
              onChange={(e) => setCond(i, { value: c.op === 'in' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value })}
              placeholder={c.field === 'priority' ? 'high, medium or low' : c.field === 'score' ? '70' : 'value'}
            />
            <button className="btn btn-ghost btn-sm" onClick={() => up({ conditions: a.conditions!.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm -ml-2" onClick={() => up({ conditions: [...a.conditions!, { field: 'score', op: 'gte', value: 70 }] })}>Add a condition</button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="label mb-1">Then, in order</legend>
        {a.actions!.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="num w-5 text-ink-3">{i + 1}</span>
            <select className="field w-64" value={x.type} onChange={(e) => setAct(i, { type: e.target.value as ActionType, params: {} })}>
              {Object.entries(ACTION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
            {x.type === 'draft_followup' && (
              <select className="field w-28" value={String(x.params.channel ?? 'sms')} onChange={(e) => setAct(i, { params: { channel: e.target.value } })}>
                <option value="sms">SMS</option><option value="email">Email</option>
              </select>
            )}
            {x.type === 'add_tag' && <input className="field w-40" placeholder="tag" value={String(x.params.tag ?? '')} onChange={(e) => setAct(i, { params: { tag: e.target.value } })} />}
            {x.type === 'move_stage' && (
              <select className="field w-36" value={String(x.params.stage ?? '')} onChange={(e) => setAct(i, { params: { stage: e.target.value } })}>
                <option value="">Choose…</option>
                {Object.entries(STAGE_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            )}
            {x.type === 'notify' && <input className="field w-48" placeholder="#channel" value={String(x.params.target ?? '')} onChange={(e) => setAct(i, { params: { channel: 'slack', target: e.target.value } })} />}
            {x.type === 'webhook' && <input className="field w-80" placeholder="https://hooks.example.com/…" value={String(x.params.url ?? '')} onChange={(e) => setAct(i, { params: { url: e.target.value } })} />}
            <button className="btn btn-ghost btn-sm" onClick={() => up({ actions: a.actions!.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm -ml-2" onClick={() => up({ actions: [...a.actions!, { type: 'add_tag', params: { tag: '' } }] })}>Add an action</button>
      </fieldset>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const list = await api<Automation[]>(a.id ? `/clients/${clientId}/automations/${a.id}` : `/clients/${clientId}/automations`, { method: a.id ? 'PUT' : 'POST', json: a });
              onDone(list);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save automation'}
        </button>
        <button className="btn btn-ghost" onClick={() => onDone()}>Cancel</button>
      </div>
    </div>
  );
}

export function AutomationsPage() {
  const { clientId } = useParams();
  const canWrite = useCanWrite();
  const list = useResource<Automation[]>(`/clients/${clientId}/automations`);
  const runs = useResource<AutomationRun[]>(`/clients/${clientId}/automation-runs`);
  const client = useResource<{ client: Client }>(`/clients/${clientId}`);
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  if (!list.data || !client.data) return <Loading />;

  async function toggle(a: Automation) {
    list.set(await api<Automation[]>(`/clients/${clientId}/automations/${a.id}`, { method: 'PUT', json: { ...a, enabled: !a.enabled } }));
  }

  return (
    <div className="max-w-[1080px] space-y-8">
      <PageHeader
        title={`${client.data.client.name}: automations`}
        sub="Rules that run the moment something happens. AI drafts always wait for a person; each automation runs at most once per lead."
        actions={canWrite && !editing && <button className="btn btn-primary" onClick={() => setEditing(blank())}>New automation</button>}
      />
      {editing && !editing.id && <Editor initial={editing} clientId={clientId!} onDone={(l) => { if (l) list.set(l); setEditing(null); }} />}

      <ul className="space-y-3">
        {list.data.map((a) =>
          editing?.id === a.id ? (
            <li key={a.id}><Editor initial={editing} clientId={clientId!} onDone={(l) => { if (l) list.set(l); setEditing(null); }} /></li>
          ) : (
            <li key={a.id} className={`panel p-4 ${a.enabled ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-[70ch]">
                  <p className="font-semibold">{a.name}</p>
                  <div className="mt-1 text-[13.5px] text-ink-2"><Sentence a={a} /></div>
                  <p className="mt-1.5 text-[12px] text-ink-3">
                    Ran {a.runs_total} time{a.runs_total === 1 ? '' : 's'}
                    {a.runs_failed ? `, ${a.runs_failed} failed` : ''}
                    {a.last_run_at ? `, last ${ago(a.last_run_at)}` : ''}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>Edit</button>
                    <button
                      role="switch"
                      aria-checked={a.enabled}
                      aria-label={`${a.name} is ${a.enabled ? 'on' : 'off'}`}
                      onClick={() => toggle(a)}
                      className={`relative h-5 w-9 rounded-full transition-colors ${a.enabled ? 'bg-blue' : 'bg-line-strong'}`}
                    >
                      <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] ${a.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                )}
              </div>
            </li>
          ),
        )}
      </ul>

      <section aria-labelledby="runs-h">
        <h2 id="runs-h" className="mb-3 text-[15px] font-semibold">Recent runs</h2>
        <ul className="panel divide-y divide-line">
          {(runs.data ?? []).map((r) => (
            <li key={r.id}>
              <button className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-4 px-4 py-2.5 text-left hover:bg-[#fafbfd] sm:grid-cols-[1fr_14rem_6rem_7rem]" onClick={() => setOpenRun(openRun === r.id ? null : r.id)} aria-expanded={openRun === r.id}>
                <span className="font-medium">{r.automation_name}</span>
                <span className="text-[13px] text-ink-2">{r.lead_name}</span>
                <span className={`text-[13px] font-medium ${r.status === 'succeeded' ? 'text-good' : r.status === 'failed' ? 'text-bad' : 'text-ink-3'}`}>{r.status}</span>
                <span className="text-right text-[12px] text-ink-3">{ago(r.started_at)}</span>
              </button>
              {openRun === r.id && (
                <div className="px-4 pb-3">
                  <ol className="space-y-1 border-l border-line pl-3">
                    {r.steps.map((s, i) => (
                      <li key={i} className="text-[12.5px]">
                        <span className={s.status === 'succeeded' ? 'text-good' : s.status === 'failed' ? 'text-bad' : 'text-ink-3'}>{s.status}</span>{' '}
                        <span className="text-ink-2">{s.detail}</span>{' '}
                        <span className="num text-ink-3">{s.ms} ms{s.attempts > 1 ? `, ${s.attempts} attempts` : ''}</span>
                      </li>
                    ))}
                  </ol>
                  <Link to={`/leads/${r.lead_id}`} className="mt-1.5 inline-block text-[12.5px] text-blue underline">Open the lead</Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
