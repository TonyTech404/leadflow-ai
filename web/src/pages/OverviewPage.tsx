import { Link, useNavigate } from 'react-router';
import type { ClientOverview, Priority } from '../../../shared/types';
import { useResource } from '../lib/api';
import { int, minutes, money, pct } from '../lib/format';
import { useSession } from '../session';
import { Loading, PageHeader, ScoreBadge, WaitClock } from '../components/ui';

interface Overview {
  clients: ClientOverview[];
  attention: Array<{
    id: string; first_name: string; last_name: string; company: string | null; priority: Priority; score: number;
    created_at: string; client_id: string; client_name: string; summary: string | null; has_draft: boolean;
  }>;
  ai_usage: { calls: number; input_tokens: number; output_tokens: number; avg_ms: number } | null;
}

// Claude Haiku 5.5 list prices per million tokens, for a rough cost line.
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;

export function OverviewPage() {
  const { session } = useSession();
  const { data } = useResource<Overview>('/overview', { pollMs: 20000, pollWhile: () => true });
  const navigate = useNavigate();
  if (!data || !session) return <Loading />;
  const colour = Object.fromEntries(session.clients.map((c) => [c.id, c.brand_color]));

  return (
    <div className="max-w-[1180px] space-y-10">
      <PageHeader
        title="Agency overview"
        sub={
          session.user.role === 'client_viewer'
            ? `You are seeing ${session.clients.map((c) => c.name).join(', ')} only, read-only.`
            : 'Every client in one place: who is waiting for a reply, and how each account is doing.'
        }
      />

      <section aria-labelledby="queue-h">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="queue-h" className="text-[15px] font-semibold">
            Waiting for a first reply
          </h2>
          <p className="text-[12.5px] text-ink-3">Hot and warm leads only. Replies inside five minutes convert far better than replies after an hour.</p>
        </div>
        {data.attention.length ? (
          <ul className="panel divide-y divide-line">
            {data.attention.map((l) => (
              <li key={l.id}>
                <Link to={`/leads/${l.id}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-[#fafbfd] sm:grid-cols-[9rem_1fr_auto_auto]">
                  <WaitClock createdAt={l.created_at} respondedAt={null} />
                  <span className="min-w-0 sm:order-none">
                    <span className="font-medium">
                      {l.first_name} {l.last_name}
                    </span>
                    {l.company && <span className="text-ink-3">, {l.company}</span>}
                    <span className="ml-2 inline-flex items-center gap-1.5 text-[12px] text-ink-3">
                      <span className="size-1.5 rounded-full" style={{ background: colour[l.client_id] }} aria-hidden />
                      {l.client_name}
                    </span>
                    {l.summary && <span className="mt-0.5 block truncate text-[13px] text-ink-2">{l.summary}</span>}
                  </span>
                  <span className="hidden text-[12.5px] font-medium text-blue sm:block">{l.has_draft ? 'Draft ready to approve' : ''}</span>
                  <ScoreBadge score={l.score} priority={l.priority} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel px-4 py-6 text-center text-ink-2">Nobody is waiting. Every hot and warm lead has had a reply.</p>
        )}
      </section>

      <section aria-labelledby="clients-h">
        <h2 id="clients-h" className="mb-3 text-[15px] font-semibold">
          Clients
        </h2>
        <div className="panel overflow-x-auto">
          <table className="table min-w-[760px]">
            <thead>
              <tr>
                <th>Client</th>
                <th className="text-right!">Leads, last 7 days</th>
                <th className="text-right!">Hot leads open</th>
                <th className="text-right!">Awaiting reply</th>
                <th className="text-right!">Median first reply</th>
                <th className="text-right!">Qualified, 30 days</th>
                <th className="text-right!">Open pipeline</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => {
                const delta = c.leads_7d - c.leads_prev_7d;
                return (
                  <tr key={c.client.id} className="row-link" onClick={() => navigate(`/c/${c.client.id}/pipeline`)}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <span className="size-2.5 rounded-full" style={{ background: c.client.brand_color }} aria-hidden />
                        <span>
                          <span className="font-medium">{c.client.name}</span>
                          <span className="block text-[12px] text-ink-3">
                            {c.client.industry}, {c.client.location}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="num text-right">
                      {int(c.leads_7d)}
                      {delta !== 0 && <span className={`ml-1.5 text-[12px] ${delta > 0 ? 'text-good' : 'text-ink-3'}`}>{delta > 0 ? `+${delta}` : delta}</span>}
                    </td>
                    <td className="num text-right">{int(c.high_open)}</td>
                    <td className={`num text-right ${c.awaiting_reply ? 'font-semibold text-hot' : ''}`}>{int(c.awaiting_reply)}</td>
                    <td className="num text-right">{minutes(c.median_response_minutes)}</td>
                    <td className="num text-right">{pct(c.qualified_rate)}</td>
                    <td className="num text-right">{money(c.pipeline_value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {data.ai_usage && (
        <section aria-labelledby="ai-h" className="max-w-2xl">
          <h2 id="ai-h" className="mb-3 text-[15px] font-semibold">
            AI in this sandbox
          </h2>
          <dl className="panel grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
            {[
              ['Model calls', int(data.ai_usage.calls)],
              ['Tokens in / out', `${int(data.ai_usage.input_tokens)} / ${int(data.ai_usage.output_tokens)}`],
              ['Average time', data.ai_usage.avg_ms ? `${(data.ai_usage.avg_ms / 1000).toFixed(1)} s` : '—'],
              ['Approximate cost', `$${((data.ai_usage.input_tokens * PRICE_IN + data.ai_usage.output_tokens * PRICE_OUT) / 1e6).toFixed(4)}`],
            ].map(([k, v]) => (
              <div key={k} className="px-4 py-3">
                <dt className="text-[12px] text-ink-3">{k}</dt>
                <dd className="num mt-0.5 font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[12.5px] text-ink-3">
            Live calls made since you opened the demo ({session.ai.live ? session.ai.model : 'demo rules'}). The sample history was scored once when the demo was built.
          </p>
        </section>
      )}
    </div>
  );
}
