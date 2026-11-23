import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { STAGES, type Campaign, type Client, type LeadSummary } from '../../../shared/types';
import { useResource } from '../lib/api';
import { ago, money, SOURCE_LABEL, STAGE_LABEL } from '../lib/format';
import { Loading, PageHeader, ScoreBadge, StageBadge, WaitClock } from '../components/ui';

export function LeadsPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [f, setF] = useState({ stage: '', priority: '', source: '', campaign: '', q: '', attention: false });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v === true ? '1' : String(v));
    return p.toString();
  }, [f]);
  const leads = useResource<LeadSummary[]>(`/clients/${clientId}/leads?${query}`, { pollMs: 8000, pollWhile: (d) => d.some((l) => l.ai_status === 'pending') });
  const client = useResource<{ client: Client; campaigns: Campaign[] }>(`/clients/${clientId}`);
  if (!client.data) return <Loading />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <div className="max-w-[1280px]">
      <PageHeader title={`${client.data.client.name}: leads`} sub="Every enquiry, newest first, with the AI's score and how fast someone replied." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="field w-56" placeholder="Search name, company or email" value={f.q} onChange={set('q')} aria-label="Search" />
        <select className="field w-auto" value={f.stage} onChange={set('stage')} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select className="field w-auto" value={f.priority} onChange={set('priority')} aria-label="Priority">
          <option value="">All priorities</option>
          <option value="high">Hot</option>
          <option value="medium">Warm</option>
          <option value="low">Cold</option>
        </select>
        <select className="field w-auto" value={f.source} onChange={set('source')} aria-label="Source">
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="field w-auto max-w-56" value={f.campaign} onChange={set('campaign')} aria-label="Campaign">
          <option value="">All campaigns</option>
          {client.data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="ml-1 inline-flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={f.attention} onChange={set('attention')} className="size-4 accent-blue" />
          Needs a first reply
        </label>
      </div>
      <div className="panel overflow-x-auto">
        <table className="table min-w-[980px]">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Score</th>
              <th>AI summary</th>
              <th>Campaign</th>
              <th>Stage</th>
              <th>First reply</th>
              <th className="text-right!">Value</th>
              <th>Arrived</th>
            </tr>
          </thead>
          <tbody>
            {(leads.data ?? []).map((l) => (
              <tr key={l.id} className="row-link" onClick={() => navigate(`/leads/${l.id}`)}>
                <td>
                  <a href={`/leads/${l.id}`} onClick={(e) => e.preventDefault()} className="font-medium hover:underline">
                    {l.first_name} {l.last_name}
                  </a>
                  <span className="block text-[12px] text-ink-3">{l.company ?? l.email ?? l.phone}</span>
                </td>
                <td><ScoreBadge score={l.score} priority={l.priority} pending={l.ai_status === 'pending'} /></td>
                <td className="max-w-[34ch] text-[13px] text-ink-2"><span className="line-clamp-2">{l.summary ?? '—'}</span></td>
                <td className="text-[13px]">
                  {l.campaign_name ?? '—'}
                  <span className="block text-[12px] text-ink-3">{SOURCE_LABEL[l.source]}</span>
                </td>
                <td><StageBadge stage={l.stage} /></td>
                <td>{l.stage === 'lost' && !l.first_response_at ? '—' : <WaitClock createdAt={l.created_at} respondedAt={l.first_response_at} compact />}</td>
                <td className="num text-right">{money(l.value)}</td>
                <td className="whitespace-nowrap text-[13px] text-ink-3">{ago(l.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.data && !leads.data.length && <p className="py-10 text-center text-ink-3">No leads match these filters.</p>}
        {!leads.data && <Loading />}
      </div>
    </div>
  );
}
