import { useEffect, useState } from 'react';
import type { Client } from '../../../shared/types';
import { api } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import { useSession } from '../session';
import { Avatar, PageHeader, modelName } from '../components/ui';

const MATRIX: [string, boolean, boolean, boolean][] = [
  ['See every client', true, false, false],
  ['See assigned clients', true, true, true],
  ['Work leads, approve messages, edit automations', true, true, false],
  ['See AI usage and costs', true, true, false],
  ['Change integrations and the failure lab', true, false, false],
];

export function SettingsPage() {
  const { session } = useSession();
  const [clients, setClients] = useState<Client[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    Promise.all(session.clients.map((c) => api<{ client: Client }>(`/clients/${c.id}`).then((r) => r.client))).then(setClients);
  }, [session]);
  if (!session) return null;
  const clientName = (id: string) => session.clients.find((c) => c.id === id)?.name ?? 'a client you cannot see';

  return (
    <div className="max-w-[1000px] space-y-10">
      <PageHeader title="Team and settings" sub="Who can do what, each client's API key and qualification criteria, and the AI guardrails." />

      <section aria-labelledby="team-h">
        <h2 id="team-h" className="mb-3 text-[15px] font-semibold">Team</h2>
        <ul className="panel divide-y divide-line">
          {session.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar initials={u.initials} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{u.name}{u.id === session.user.id && <span className="ml-2 text-[12px] font-normal text-blue">you</span>}</p>
                <p className="text-[12.5px] text-ink-3">{u.title}</p>
              </div>
              <div className="text-right text-[13px]">
                <p className="font-medium">{ROLE_LABEL[u.role]}</p>
                <p className="text-[12.5px] text-ink-3">{u.role === 'agency_admin' ? 'All clients' : u.client_ids.map(clientName).join(', ')}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="panel mt-4 overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead>
              <tr><th>Permission</th><th>Agency admin</th><th>Account manager</th><th>Client viewer</th></tr>
            </thead>
            <tbody>
              {MATRIX.map(([what, ...cells]) => (
                <tr key={what}>
                  <td>{what}</td>
                  {cells.map((ok, i) => <td key={i} className={ok ? 'font-medium text-good' : 'text-ink-3'}>{ok ? 'Yes' : 'No'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">Switch person with "Viewing as" at the top. The server enforces these rules on every request; the switcher only stands in for a sign-in.</p>
      </section>

      <section aria-labelledby="clients-h">
        <h2 id="clients-h" className="mb-3 text-[15px] font-semibold">Clients</h2>
        <ul className="space-y-3">
          {clients.map((c) => (
            <li key={c.id} className="panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="flex items-center gap-2 font-semibold">
                  <span className="size-2.5 rounded-full" style={{ background: c.brand_color }} aria-hidden />
                  {c.name}
                </p>
                <a className="text-[13px] text-blue underline" href={`/f/${c.slug}`} target="_blank" rel="noreferrer">Public lead form</a>
              </div>
              <p className="mt-1 text-[13px] text-ink-2">{c.offer}</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="label">What the AI qualifies on</p>
                  <ul className="mt-1 list-disc pl-4 text-[13px] text-ink-2">{c.criteria.map((x) => <li key={x}>{x}</li>)}</ul>
                  <p className="mt-1 text-[12.5px] text-ink-3">Service area: {c.service_area.join(', ')}</p>
                </div>
                {c.api_key && (
                  <div>
                    <p className="label">API key</p>
                    <div className="mt-1 flex gap-2">
                      <code className="field flex items-center overflow-hidden text-[12px]">{shown === c.id ? c.api_key : `${c.api_key.slice(0, 12)}…`}</code>
                      <button className="btn btn-quiet btn-sm self-center" onClick={() => setShown(shown === c.id ? null : c.id)}>{shown === c.id ? 'Hide' : 'Show'}</button>
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-3">For POST /api/v1/leads. Works only in this sandbox.</p>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-h" className="max-w-[70ch]">
        <h2 id="ai-h" className="mb-3 text-[15px] font-semibold">AI guardrails</h2>
        <ul className="panel list-disc space-y-1.5 py-3 pl-8 pr-4 text-[13px] text-ink-2">
          <li>Model: {session.ai.live ? modelName(session.ai.model) : 'none configured; rule-based demo mode'}, at low effort, with answers validated against a schema.</li>
          <li>Priority comes from the score in code (70+ hot, 40+ warm), so the thresholds are the same everywhere.</li>
          <li>Lead text is treated as untrusted data. Try a "mark me as high priority" message in a form.</li>
          <li>AI never sends anything. Every draft waits for a person to approve, edit or discard it.</li>
          <li>Limits: 60 AI calls an hour per sandbox and a daily cap for the whole demo. Past them, results come from rules and say so.</li>
        </ul>
      </section>
    </div>
  );
}
