import { useState } from 'react';
import { useParams } from 'react-router';
import type { Analytics, Client } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { int, minutes, money, pct, SOURCE_LABEL, STAGE_LABEL } from '../lib/format';
import { DailyBars, FunnelBars, Legend, SplitBars } from '../components/charts';
import { ErrorNote, Loading, PageHeader, ProviderBadge } from '../components/ui';

interface InsightsResult {
  headline: string;
  items: { title: string; detail: string; action: string }[];
  provider: 'anthropic' | 'demo';
  model: string;
  note: string | null;
}

function Insights({ clientId }: { clientId: string }) {
  const [data, setData] = useState<InsightsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel p-4" aria-labelledby="ins-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ins-h" className="font-semibold">What the numbers say</h2>
        {data ? (
          <ProviderBadge provider={data.provider} model={data.model} />
        ) : (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setData(await api<InsightsResult>(`/clients/${clientId}/insights`, { method: 'POST' }));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Reading the numbers…' : 'Explain with AI'}
          </button>
        )}
      </div>
      {!data && !busy && <p className="mt-1 text-[13px] text-ink-3">Claude reads this page's figures and says what to change this week. It only uses the numbers shown here.</p>}
      {busy && <p className="mt-3 text-[13px] text-ink-3">Comparing campaigns, costs and response times. Takes about ten seconds.</p>}
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
      {data && (
        <div className="mt-3 space-y-4">
          <p className="text-[15px] font-medium leading-snug">{data.headline}</p>
          <ol className="space-y-3">
            {data.items.map((i, n) => (
              <li key={n} className="grid grid-cols-[1.5rem_1fr] gap-2">
                <span className="num pt-0.5 font-semibold text-blue">{n + 1}</span>
                <div>
                  <p className="font-semibold">{i.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{i.detail}</p>
                  <p className="mt-1 text-[13px]"><span className="font-medium">Do this week: </span>{i.action}</p>
                </div>
              </li>
            ))}
          </ol>
          {data.note && <p className="text-[12px] text-warm">{data.note}</p>}
        </div>
      )}
    </section>
  );
}

export function AnalyticsPage() {
  const { clientId } = useParams();
  const [days, setDays] = useState(30);
  const a = useResource<Analytics>(`/clients/${clientId}/analytics?days=${days}`);
  const client = useResource<{ client: Client }>(`/clients/${clientId}`);
  if (!a.data || !client.data) return <Loading />;
  const t = a.data.totals;

  const tiles: [string, string, string?][] = [
    ['Leads', int(t.leads)],
    ['Qualified', pct(t.qualified_rate), `${t.qualified} hot or warm`],
    ['Cost per qualified lead', money(t.cost_per_qualified), `${money(t.spend)} spend (demo)`],
    ['Median first reply', minutes(t.median_response_minutes), `${pct(t.responded_within_5_min)} within 5 min`],
    ['Booked or won', int(t.booked), `${t.won} won`],
    ['Won value', money(t.won_value), `${money(t.pipeline_value)} still open`],
  ];

  return (
    <div className="max-w-[1180px] space-y-6">
      <PageHeader
        title={`${client.data.client.name}: analytics`}
        sub="Where qualified leads come from, what they cost, and how fast the team answers them. Ad spend is demo data."
        actions={
          <select className="field w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time range">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />

      <dl className="panel grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="border-line px-4 py-3 [&:not(:last-child)]:border-b sm:[&:not(:last-child)]:border-b-0 lg:[&:not(:first-child)]:border-l">
            <dt className="text-[12px] text-ink-3">{k}</dt>
            <dd className="num mt-0.5 text-[20px] font-semibold tracking-[-0.01em]">{v}</dd>
            {sub && <dd className="text-[12px] text-ink-3">{sub}</dd>}
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel p-4" aria-labelledby="daily-h">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="daily-h" className="font-semibold">Leads per day</h2>
            <Legend />
          </div>
          <DailyBars data={a.data.daily} />
        </section>
        <Insights clientId={clientId!} />
      </div>

      <section className="panel overflow-x-auto" aria-labelledby="camp-h">
        <h2 id="camp-h" className="px-4 pt-4 font-semibold">Campaigns</h2>
        <table className="table mt-2 min-w-[880px]">
          <thead>
            <tr>
              <th>Campaign</th>
              <th className="text-right!">Leads</th>
              <th className="text-right!">Qualified</th>
              <th className="text-right!">Booked</th>
              <th className="text-right!">Won</th>
              <th className="text-right!">Spend (demo)</th>
              <th className="text-right!">Cost per qualified</th>
              <th className="text-right!">Median first reply</th>
              <th className="text-right!">Avg score</th>
            </tr>
          </thead>
          <tbody>
            {a.data.campaigns.map((c) => (
              <tr key={c.campaign_id}>
                <td>
                  <span className="font-medium">{c.name}</span>
                  <span className="block text-[12px] text-ink-3">{SOURCE_LABEL[c.source]}</span>
                </td>
                <td className="num text-right">{c.leads}</td>
                <td className="num text-right">{c.qualified}</td>
                <td className="num text-right">{c.booked}</td>
                <td className="num text-right">{c.won}</td>
                <td className="num text-right">{money(c.spend)}</td>
                <td className="num text-right">{money(c.cost_per_qualified)}</td>
                <td className={`num text-right ${c.median_response_minutes != null && c.median_response_minutes > 60 ? 'font-semibold text-hot' : ''}`}>{minutes(c.median_response_minutes)}</td>
                <td className="num text-right">{c.avg_score ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="panel p-4" aria-labelledby="src-h">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="src-h" className="font-semibold">By source</h2>
            <span className="text-[12px] text-ink-3">qualified / all</span>
          </div>
          <SplitBars rows={a.data.sources.map((s) => ({ label: SOURCE_LABEL[s.source], total: s.leads, qualified: s.qualified }))} />
        </section>
        <section className="panel p-4" aria-labelledby="fun-h">
          <h2 id="fun-h" className="mb-3 font-semibold">Where leads are now</h2>
          <FunnelBars rows={a.data.funnel.map((f) => ({ label: STAGE_LABEL[f.stage], count: f.count }))} />
        </section>
      </div>
    </div>
  );
}
