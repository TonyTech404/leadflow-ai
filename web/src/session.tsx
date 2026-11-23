import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '../../shared/types';
import { api } from './lib/api';

interface Ctx {
  session: Session | null;
  error: string | null;
  viewAs: (userId: string) => Promise<void>;
  reset: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Bumped when the person or sandbox changes, so pages refetch. */
  version: number;
}

const SessionCtx = createContext<Ctx | null>(null);

// The first visit creates the sandbox, so request it once even under StrictMode.
let first: Promise<Session> | null = null;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    first ??= api<Session>('/session');
    first.then(setSession).catch((e) => setError((e as Error).message));
  }, []);

  const viewAs = useCallback(async (userId: string) => {
    setSession(await api<Session>('/session/viewer', { method: 'POST', json: { user_id: userId } }));
    setVersion((v) => v + 1);
  }, []);
  const reset = useCallback(async () => {
    setSession(await api<Session>('/session/reset', { method: 'POST' }));
    setVersion((v) => v + 1);
  }, []);
  const refresh = useCallback(async () => setSession(await api<Session>('/session')), []);

  return <SessionCtx.Provider value={{ session, error, viewAs, reset, refresh, version }}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession outside provider');
  return c;
}

/** Whether the current person can change this client's leads. */
export function useCanWrite() {
  const { session } = useSession();
  return session?.user.role !== 'client_viewer';
}
