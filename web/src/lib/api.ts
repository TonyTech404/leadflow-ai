import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Fetches a resource; `reload` refetches; optional polling while `pollWhile` holds. */
export function useResource<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (d: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(path);
  current.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const v = await api<T>(path);
      if (current.current === path) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);
  const { pollMs, pollWhile } = opts;
  useEffect(() => {
    if (!pollMs || !data || (pollWhile && !pollWhile(data))) return;
    const t = setTimeout(() => void reload(), pollMs);
    return () => clearTimeout(t);
  }, [pollMs, pollWhile, data, reload]);
  return { data, error, reload, set: setData };
}
