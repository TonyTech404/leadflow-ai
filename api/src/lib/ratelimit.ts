import type { Sql } from '../db.js';

/** Fixed-window counter in Postgres. Returns false once `limit` hits land in the current window. */
export async function allow(sql: Sql, key: string, windowSeconds: number, limit: number): Promise<boolean> {
  const [row] = await sql<{ count: number }[]>`
    insert into rate_limits (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
    on conflict (key, window_start) do update set count = rate_limits.count + 1
    returning count`;
  return row.count <= limit;
}
