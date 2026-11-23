import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { STAGES, type Client, type LeadSummary, type Stage } from '../../../shared/types';
import { api, useResource } from '../lib/api';
import { money, SOURCE_LABEL, STAGE_LABEL } from '../lib/format';
import { useCanWrite, useSession } from '../session';
import { ErrorNote, Loading, PageHeader, ScoreBadge, WaitClock } from '../components/ui';

function Card({ lead, draggable }: { lead: LeadSummary; draggable: boolean }) {
  const { session } = useSession();
  const owner = session?.users.find((u) => u.id === lead.owner_id);
  return (
    <Link
      to={`/leads/${lead.id}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/lead', lead.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="block rounded-lg border border-line bg-white p-3 shadow-[0_1px_0_rgb(14_26_47/0.04)] transition-colors hover:border-line-strong"
    >
      <p className="font-medium leading-snug">
        {lead.first_name} {lead.last_name}
      </p>
      <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{lead.company ?? lead.campaign_name ?? SOURCE_LABEL[lead.source]}</p>
      {lead.summary && <p className="mt-2 line-clamp-2 text-[12.5px] leading-snug text-ink-2">{lead.summary}</p>}
      {lead.has_draft && <p className="mt-2 text-[12px] font-medium text-blue">Draft to approve</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <ScoreBadge score={lead.score} priority={lead.priority} pending={lead.ai_status === 'pending'} />
        {lead.stage === 'new' ? <WaitClock createdAt={lead.created_at} respondedAt={lead.first_response_at} compact /> : lead.value ? <span className="num text-[12px] text-ink-2">{money(lead.value)}</span> : null}
        {owner && (
          <span className="ml-auto inline-flex size-6 items-center justify-center rounded-full bg-navy text-[10px] font-semibold text-white" title={owner.name}>
            {owner.initials}
          </span>
        )}
      </div>
    </Link>
  );
}

export function PipelinePage() {
  const { clientId } = useParams();
  const canWrite = useCanWrite();
  const leads = useResource<LeadSummary[]>(`/clients/${clientId}/leads`, { pollMs: 8000, pollWhile: (d) => d.some((l) => l.ai_status === 'pending') });
  const client = useResource<{ client: Client }>(`/clients/${clientId}`);
  const [over, setOver] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!leads.data || !client.data) return <Loading />;
  const c = client.data.client;

  async function move(id: string, stage: Stage) {
    const before = leads.data!;
    leads.set(before.map((l) => (l.id === id ? { ...l, stage } : l)));
    try {
      await api(`/leads/${id}`, { method: 'PATCH', json: { stage } });
      void leads.reload();
    } catch (e) {
      leads.set(before);
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-full" style={{ background: c.brand_color }} aria-hidden />
            {c.name}
          </span>
        }
        sub={`${c.industry}, ${c.location}. ${canWrite ? 'Drag a card to move it between stages.' : 'Read-only view for the client.'}`}
        actions={
          <a className="btn btn-quiet" href={`/f/${c.slug}`} target="_blank" rel="noreferrer">
            Open the lead form
          </a>
        }
      />
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="grid min-w-[1080px] grid-cols-6 gap-2.5">
          {STAGES.map((stage) => {
            const col = leads.data!.filter((l) => l.stage === stage);
            const value = col.reduce((s, l) => s + (l.value ?? 0), 0);
            return (
              <section
                key={stage}
                aria-label={STAGE_LABEL[stage]}
                onDragOver={(e) => {
                  if (!canWrite) return;
                  e.preventDefault();
                  setOver(stage);
                }}
                onDragLeave={() => setOver((s) => (s === stage ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = e.dataTransfer.getData('text/lead');
                  if (id && canWrite) void move(id, stage);
                }}
                className={`rounded-xl p-2 transition-colors ${over === stage ? 'bg-blue-wash' : 'bg-[#eef1f5]'}`}
              >
                <header className="flex items-baseline justify-between px-1.5 pb-2 pt-1">
                  <h2 className="text-[13px] font-semibold">
                    {STAGE_LABEL[stage]} <span className="num font-normal text-ink-3">{col.length}</span>
                  </h2>
                  {value > 0 && <span className="num text-[12px] text-ink-3">{money(value)}</span>}
                </header>
                <div className="space-y-2">
                  {col.map((l) => (
                    <Card key={l.id} lead={l} draggable={canWrite} />
                  ))}
                  {!col.length && <p className="px-1.5 py-6 text-center text-[12.5px] text-ink-3">No leads</p>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
