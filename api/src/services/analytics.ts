// Campaign analytics and the agency overview, computed in SQL.
// "Qualified" means AI priority high or medium. Spend figures are demo data and labelled so.
import type { Sql } from '../db.js';
import type { Analytics, CampaignStats, ClientOverview, ClientSummary, Source, Stage } from '../../../shared/types.js';

const round = (n: number | null, dp = 0) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

export async function clientAnalytics(sql: Sql, clientId: string, days = 30): Promise<Analytics> {
  const since = sql`now() - ${days} * interval '1 day'`;

  const [t] = await sql`
    select count(*)::int as leads,
           count(*) filter (where priority in ('high', 'medium'))::int as qualified,
           count(*) filter (where stage in ('booked', 'won'))::int as booked,
           count(*) filter (where stage = 'won')::int as won,
           coalesce(sum(value) filter (where stage not in ('won', 'lost')), 0)::float8 as pipeline_value,
           coalesce(sum(value) filter (where stage = 'won'), 0)::float8 as won_value,
           percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at) / 60)
             filter (where first_response_at is not null)::float8 as median_response,
           (count(*) filter (where first_response_at is not null and first_response_at - created_at <= interval '5 minutes'))::float8
             / nullif(count(*) filter (where first_response_at is not null), 0) as within_5
    from leads where client_id = ${clientId}::uuid and created_at >= ${since}`;

  const [{ spend }] = await sql<{ spend: number }[]>`select coalesce(sum(spend), 0)::float8 as spend from campaigns where client_id = ${clientId}::uuid`;

  const campaigns = await sql<Array<CampaignStats & { median_response: number | null }>>`
    select cp.id as campaign_id, cp.name, cp.source, cp.spend::float8 as spend,
           count(l.id)::int as leads,
           count(l.id) filter (where l.priority in ('high', 'medium'))::int as qualified,
           count(l.id) filter (where l.priority = 'high')::int as high,
           count(l.id) filter (where l.stage in ('booked', 'won'))::int as booked,
           count(l.id) filter (where l.stage = 'won')::int as won,
           avg(l.score)::float8 as avg_score,
           percentile_cont(0.5) within group (order by extract(epoch from l.first_response_at - l.created_at) / 60)
             filter (where l.first_response_at is not null)::float8 as median_response
    from campaigns cp
    left join leads l on l.campaign_id = cp.id and l.created_at >= ${since}
    where cp.client_id = ${clientId}::uuid
    group by cp.id
    order by count(l.id) filter (where l.priority in ('high', 'medium')) desc, cp.name`;

  const daily = await sql<{ date: string; leads: number; qualified: number }[]>`
    select to_char(d, 'YYYY-MM-DD') as date,
           count(l.id)::int as leads,
           count(l.id) filter (where l.priority in ('high', 'medium'))::int as qualified
    from generate_series((now() - ${days - 1} * interval '1 day')::date, now()::date, interval '1 day') d
    left join leads l on l.client_id = ${clientId}::uuid and l.created_at::date = d::date
    group by d order by d`;

  const sources = await sql<{ source: Source; leads: number; qualified: number }[]>`
    select source, count(*)::int as leads, count(*) filter (where priority in ('high', 'medium'))::int as qualified
    from leads where client_id = ${clientId}::uuid and created_at >= ${since}
    group by source order by count(*) desc`;

  const funnelRows = await sql<{ stage: Stage; count: number }[]>`
    select stage, count(*)::int as count from leads where client_id = ${clientId}::uuid and created_at >= ${since} group by stage`;
  const order: Stage[] = ['new', 'contacted', 'qualified', 'booked', 'won', 'lost'];
  const funnel = order.map((stage) => ({ stage, count: funnelRows.find((r) => r.stage === stage)?.count ?? 0 }));

  return {
    days,
    totals: {
      leads: t.leads,
      qualified: t.qualified,
      qualified_rate: t.leads ? t.qualified / t.leads : null,
      booked: t.booked,
      won: t.won,
      pipeline_value: t.pipeline_value,
      won_value: t.won_value,
      spend,
      cost_per_qualified: t.qualified ? Math.round(spend / t.qualified) : null,
      median_response_minutes: round(t.median_response),
      responded_within_5_min: t.within_5,
    },
    daily,
    sources,
    funnel,
    campaigns: campaigns.map(({ median_response, ...c }) => ({
      ...c,
      avg_score: round(c.avg_score),
      cost_per_lead: c.leads ? Math.round(c.spend / c.leads) : null,
      cost_per_qualified: c.qualified ? Math.round(c.spend / c.qualified) : null,
      median_response_minutes: round(median_response),
    })),
  };
}

export async function agencyOverview(sql: Sql, clientIds: string[]): Promise<ClientOverview[]> {
  if (!clientIds.length) return [];
  const rows = await sql`
    select c.id, c.slug, c.name, c.industry, c.location, c.brand_color,
           count(l.id) filter (where l.created_at >= now() - interval '7 days')::int as leads_7d,
           count(l.id) filter (where l.created_at >= now() - interval '14 days' and l.created_at < now() - interval '7 days')::int as leads_prev_7d,
           count(l.id) filter (where l.priority = 'high' and l.stage not in ('won', 'lost'))::int as high_open,
           count(l.id) filter (where l.stage = 'new' and l.first_response_at is null)::int as awaiting_reply,
           percentile_cont(0.5) within group (order by extract(epoch from l.first_response_at - l.created_at) / 60)
             filter (where l.first_response_at is not null and l.created_at >= now() - interval '30 days')::float8 as median_response,
           (count(l.id) filter (where l.priority in ('high', 'medium') and l.created_at >= now() - interval '30 days'))::float8
             / nullif(count(l.id) filter (where l.created_at >= now() - interval '30 days'), 0) as qualified_rate,
           coalesce(sum(l.value) filter (where l.stage not in ('won', 'lost')), 0)::float8 as pipeline_value
    from clients c left join leads l on l.client_id = c.id
    where c.id = any(${clientIds}::uuid[])
    group by c.id order by c.name`;
  return rows.map((r) => ({
    client: { id: r.id, slug: r.slug, name: r.name, industry: r.industry, location: r.location, brand_color: r.brand_color } as ClientSummary,
    leads_7d: r.leads_7d,
    leads_prev_7d: r.leads_prev_7d,
    high_open: r.high_open,
    awaiting_reply: r.awaiting_reply,
    median_response_minutes: round(r.median_response),
    qualified_rate: r.qualified_rate,
    pipeline_value: r.pipeline_value,
  }));
}
