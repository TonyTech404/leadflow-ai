import { useEffect, useState, type ReactNode } from 'react';
import type { Priority } from '../../../shared/types';
import { INTENT_LABEL, SOURCE_LABEL, STAGE_LABEL, minutes } from '../lib/format';

const PRIORITY: Record<Priority, { label: string; cls: string }> = {
  high: { label: 'Hot', cls: 'bg-hot-wash text-hot' },
  medium: { label: 'Warm', cls: 'bg-warm-wash text-warm' },
  low: { label: 'Cold', cls: 'bg-cool-wash text-cool' },
};

/** Score and priority together: the number is the evidence, the word is the decision. */
export function ScoreBadge({ score, priority, pending }: { score: number | null; priority: Priority | null; pending?: boolean }) {
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-wash px-2 py-0.5 text-[12px] font-medium text-blue">
        <span className="size-1.5 animate-pulse rounded-full bg-blue" aria-hidden />
        Scoring
      </span>
    );
  }
  if (score == null || !priority) return <span className="text-[12px] text-ink-3">Unscored</span>;
  const p = PRIORITY[priority];
  return (
    <span className={`num inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold ${p.cls}`}>
      {score}
      <span className="font-medium">{p.label}</span>
    </span>
  );
}

export const StageBadge = ({ stage }: { stage: string }) => (
  <span className="inline-flex rounded-md border border-line px-1.5 py-0.5 text-[12px] text-ink-2">{STAGE_LABEL[stage] ?? stage}</span>
);

export const SourceTag = ({ source }: { source: string }) => <span className="text-[12px] text-ink-3">{SOURCE_LABEL[source] ?? source}</span>;

export const IntentText = ({ intent }: { intent: string | null }) => (intent ? <>{INTENT_LABEL[intent] ?? intent}</> : null);

export function Avatar({ initials, name, size = 26 }: { initials: string; name?: string; size?: number }) {
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-navy font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </span>
  );
}

function useNow(ms = 15000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Speed to lead. A waiting lead shows a live clock that turns hot after five minutes; an answered
 * lead shows how long the first reply took.
 */
export function WaitClock({ createdAt, respondedAt, compact }: { createdAt: string; respondedAt: string | null; compact?: boolean }) {
  const now = useNow();
  if (respondedAt) {
    const m = (new Date(respondedAt).getTime() - new Date(createdAt).getTime()) / 60000;
    return (
      <span className={`num text-[12px] ${m <= 5 ? 'text-good' : 'text-ink-3'}`} title="Time to first reply">
        {compact ? '' : 'Replied in '}
        {minutes(m)}
      </span>
    );
  }
  const m = (now - new Date(createdAt).getTime()) / 60000;
  const late = m > 5;
  return (
    <span
      className={`num inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium ${late ? 'bg-hot-wash text-hot' : 'bg-good-wash text-good'}`}
      title="Waiting for a first reply"
    >
      <span className={`size-1.5 rounded-full ${late ? 'bg-hot' : 'bg-good'} ${m < 60 ? 'animate-pulse' : ''}`} aria-hidden />
      {compact ? '' : 'Waiting '}
      {minutes(m)}
    </span>
  );
}

/** "claude-haiku-5-5" -> "Claude Haiku 5.5" */
export const modelName = (model: string) =>
  model
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/** Says where an AI answer came from. A demo answer is never shown as an AI call. */
export function ProviderBadge({ provider, model }: { provider: 'anthropic' | 'demo'; model: string }) {
  return provider === 'anthropic' ? (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-px text-[11px] text-ink-2" title="Real AI call through the Claude API">
      {modelName(model)}
    </span>
  ) : (
    <span className="inline-flex items-center rounded border border-warm/40 bg-warm-wash px-1.5 py-px text-[11px] text-warm" title="Rule-based demo result, no AI call">
      Demo rules, no AI call
    </span>
  );
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
        {sub && <p className="mt-1 max-w-[70ch] text-ink-2">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <div className="py-16 text-center text-ink-3" role="status">
    {label}…
  </div>
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <p className="rounded-md bg-bad-wash px-3 py-2 text-[13px] text-bad" role="alert">
    {children}
  </p>
);

export function SimBadge({ children = 'Simulated' }: { children?: ReactNode }) {
  return <span className="inline-flex rounded border border-line-strong px-1.5 py-px text-[11px] font-medium text-ink-2">{children}</span>;
}
