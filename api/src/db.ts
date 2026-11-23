import postgres from 'postgres';

export type Sql = postgres.Sql | postgres.TransactionSql;

const isWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

/** Workers sockets can't do channel binding, and Neon's strings ask for it. */
export function cleanUrl(url: string): string {
  return url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
}

function create(url: string, max: number) {
  return postgres(cleanUrl(url), {
    max,
    prepare: false, // Neon's pooled endpoint runs PgBouncer in transaction mode
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    types: {
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
}

let shared: postgres.Sql | undefined;

/**
 * A client for one request. Workers can't share sockets between requests, so each request gets
 * its own single connection and closes it afterwards; Node keeps one pool for the process.
 */
export function openDb(url: string): { sql: postgres.Sql; close: () => Promise<void> } {
  if (isWorkers) {
    const sql = create(url, 1);
    return { sql, close: () => sql.end({ timeout: 5 }) };
  }
  shared ??= create(url, 8);
  return { sql: shared, close: async () => {} };
}

export async function closeShared() {
  await shared?.end({ timeout: 5 });
  shared = undefined;
}
