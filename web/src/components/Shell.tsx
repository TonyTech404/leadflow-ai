import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useSession } from '../session';
import { ROLE_LABEL } from '../lib/format';
import { Avatar, Loading } from './ui';

export const REPO_URL = 'https://github.com/TonyTech404/leadflow-ai';

function navCls({ isActive }: { isActive: boolean }) {
  return `flex items-center rounded-md px-2.5 py-1.5 text-[13.5px] ${isActive ? 'bg-blue-wash font-medium text-blue' : 'text-ink-2 hover:bg-cool-wash hover:text-ink'}`;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useSession();
  const { clientId } = useParams();
  const location = useLocation();
  const activeClient = clientId ?? (location.pathname.startsWith('/leads/') ? sessionStorage.getItem('lf.client') : null);
  if (!session) return null;
  return (
    <nav className="flex h-full flex-col gap-6 px-3 py-4" aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="px-2.5">
        <p className="text-[17px] font-bold tracking-[-0.02em] text-navy">LeadFlow AI</p>
        <p className="text-[12px] text-ink-3">{session.agency.name}</p>
      </div>
      <div className="space-y-0.5">
        <NavLink to="/" end className={navCls}>Agency overview</NavLink>
        {session.can.manage_agency && <NavLink to="/integrations" className={navCls}>Integrations</NavLink>}
        <NavLink to="/settings" className={navCls}>Team and settings</NavLink>
        <NavLink to="/developers" className={navCls}>API</NavLink>
      </div>
      <div>
        <p className="px-2.5 pb-1.5 text-[12px] font-medium text-ink-3">Clients</p>
        <div className="space-y-3">
          {session.clients.map((c) => {
            const open = activeClient === c.id;
            return (
              <div key={c.id}>
                <NavLink to={`/c/${c.id}/pipeline`} className={() => `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13.5px] ${open ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink'}`}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: c.brand_color }} aria-hidden />
                  <span className="truncate">{c.name}</span>
                </NavLink>
                {open && (
                  <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-line pl-2">
                    <NavLink to={`/c/${c.id}/pipeline`} className={navCls}>Pipeline</NavLink>
                    <NavLink to={`/c/${c.id}/leads`} className={navCls}>Leads</NavLink>
                    <NavLink to={`/c/${c.id}/analytics`} className={navCls}>Analytics</NavLink>
                    <NavLink to={`/c/${c.id}/automations`} className={navCls}>Automations</NavLink>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-auto px-2.5 text-[12px] leading-relaxed text-ink-3">
        A working demo by Anthony Hernandez. Every client, lead and number here is fictional.{' '}
        <a href={REPO_URL} className="underline hover:text-ink">Source on GitHub</a>
      </div>
    </nav>
  );
}

function ViewingAs() {
  const { session, viewAs } = useSession();
  const navigate = useNavigate();
  if (!session) return null;
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Avatar initials={session.user.initials} name={session.user.name} size={24} />
      <span className="hidden text-ink-3 sm:inline">Viewing as</span>
      <select
        className="field h-8 w-auto max-w-[15rem] py-0 text-[13px]"
        value={session.user.id}
        onChange={async (e) => {
          await viewAs(e.target.value);
          navigate('/');
        }}
        aria-label="Switch person"
      >
        {session.users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({ROLE_LABEL[u.role]})
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell() {
  const { session, error, version, reset } = useSession();
  const [menu, setMenu] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { clientId } = useParams();
  if (clientId) sessionStorage.setItem('lf.client', clientId);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="hidden border-r border-line bg-[#fbfcfd] lg:sticky lg:top-0 lg:block lg:h-screen lg:overflow-y-auto">
        <Sidebar />
      </aside>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-ink/30" aria-label="Close menu" onClick={() => setMenu(false)} />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white shadow-xl">
            <Sidebar onNavigate={() => setMenu(false)} />
          </div>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-white/90 px-4 py-2.5 backdrop-blur sm:px-6">
          <button className="btn btn-ghost btn-sm lg:hidden" onClick={() => setMenu(true)} aria-label="Open menu">Menu</button>
          <p className="text-[12.5px] text-ink-3">
            <span className="mr-2 rounded bg-warm-wash px-1.5 py-0.5 font-medium text-warm">Demo</span>
            Fictional data in your own sandbox. AI calls are live; CRM, email and SMS are simulated.
          </p>
          <div className="ml-auto flex items-center gap-3">
            <ViewingAs />
            <button
              className="btn btn-ghost btn-sm"
              disabled={resetting}
              onClick={async () => {
                if (!confirm('Start over with fresh sample data? Changes in this sandbox will be lost.')) return;
                setResetting(true);
                await reset();
                setResetting(false);
              }}
            >
              {resetting ? 'Resetting…' : 'Reset demo'}
            </button>
          </div>
        </header>
        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {error ? (
            <p className="py-20 text-center text-bad">{error}</p>
          ) : session ? (
            <Outlet key={version} />
          ) : (
            <Loading label="Setting up your sandbox agency" />
          )}
        </main>
      </div>
    </div>
  );
}
