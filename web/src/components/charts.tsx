// Small SVG charts. Two categorical colours only (qualified vs other), validated for colour-blind
// separation and contrast; thin marks, a 2px gap between stacked segments, rounded data ends,
// recessive axes, a legend, and a hover tooltip on every mark.
import { useState } from 'react';

const Q = 'var(--color-chart-qualified)';
const O = 'var(--color-chart-other)';

export function Legend() {
  return (
    <div className="flex items-center gap-4 text-[12px] text-ink-2">
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: Q }} />Qualified (hot or warm)</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: O }} />Other leads</span>
    </div>
  );
}

/** Leads per day, qualified stacked under the rest. */
export function DailyBars({ data }: { data: { date: string; leads: number; qualified: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 180;
  const pad = { l: 28, r: 8, t: 10, b: 22 };
  const max = Math.max(2, ...data.map((d) => d.leads));
  const ticks = max <= 4 ? [0, max] : [0, Math.round(max / 2), max];
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const label = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Leads per day, qualified and other">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--color-ink-3)">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          const other = d.leads - d.qualified;
          const yq = y(d.qualified);
          const yt = y(d.leads);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {d.qualified > 0 && <rect x={x} y={yq} width={w} height={Math.max(0, y(0) - yq)} rx={other > 0 ? 0 : 3} fill={Q} opacity={hover == null || hover === i ? 1 : 0.55} />}
              {other > 0 && <rect x={x} y={yt} width={w} height={Math.max(0, yq - yt - (d.qualified > 0 ? 2 : 0))} rx={3} fill={O} opacity={hover == null || hover === i ? 1 : 0.55} />}
              {(i % 7 === 0 || (i === data.length - 1 && i % 7 > 3)) && (
                <text x={pad.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--color-ink-3)">{label(d.date)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-0 rounded-md border border-line bg-white px-2.5 py-1.5 text-[12px] shadow-md"
          style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <p className="font-semibold">{label(data[hover].date)}</p>
          <p className="num">{data[hover].leads} leads, {data[hover].qualified} qualified</p>
        </div>
      )}
    </div>
  );
}

/** Horizontal bars: total length is leads, the blue part qualified. */
export function SplitBars({ rows }: { rows: { label: string; total: number; qualified: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[8.5rem_1fr_3.5rem] items-center gap-3 text-[13px]" title={`${r.label}: ${r.total} leads, ${r.qualified} qualified`}>
          <span className="truncate text-ink-2">{r.label}</span>
          <span className="flex h-3 gap-[2px]" style={{ width: `${(r.total / max) * 100}%` }}>
            {r.qualified > 0 && <span className="h-full rounded-l-[3px]" style={{ width: `${(r.qualified / r.total) * 100}%`, background: Q, borderRadius: r.qualified === r.total ? 3 : undefined }} />}
            {r.total - r.qualified > 0 && <span className="h-full flex-1 rounded-r-[3px]" style={{ background: O, borderRadius: r.qualified === 0 ? 3 : undefined }} />}
          </span>
          <span className="num text-right text-ink-2">{r.qualified}/{r.total}</span>
        </li>
      ))}
    </ul>
  );
}

/** One hue for one measure: how many leads sit in each stage. */
export function FunnelBars({ rows }: { rows: { label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[6rem_1fr_2.5rem] items-center gap-3 text-[13px]" title={`${r.label}: ${r.count}`}>
          <span className="text-ink-2">{r.label}</span>
          <span className="h-3 rounded-[3px]" style={{ width: `${Math.max(2, (r.count / max) * 100)}%`, background: r.count ? Q : 'var(--color-line)' }} />
          <span className="num text-right text-ink-2">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}
