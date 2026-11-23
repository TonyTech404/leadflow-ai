// Demo sandboxes: each visitor gets their own agency, seeded with sample data.
import type { Sql } from '../db.js';
import { HttpError } from '../lib/http.js';
import { allow } from '../lib/ratelimit.js';
import { seedAgency } from '../seed/seed.js';
import { loadUsers, type Actor } from './access.js';
import type { GhlMode } from '../../../shared/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findAgency(sql: Sql, id: string | undefined) {
  if (!id || !UUID.test(id)) return null;
  const [a] = await sql<{ id: string; name: string; ghl_mode: GhlMode }[]>`
    update agencies set last_seen_at = now() where id = ${id}::uuid returning id, name, ghl_mode`;
  return a ?? null;
}

export async function createAgency(sql: Sql, ip: string) {
  if (!(await allow(sql, `sandbox:${ip}`, 3600, 20))) throw new HttpError(429, 'Too many new demo sessions from this network. Try again in an hour.');
  return sql.begin(async (tx) => {
    const [a] = await tx<{ id: string; name: string; ghl_mode: GhlMode }[]>`
      insert into agencies (name) values ('Northlight Growth (demo agency)') returning id, name, ghl_mode`;
    await seedAgency(tx, a.id);
    return a;
  });
}

/** The person the visitor is "viewing as"; defaults to the agency admin. */
export async function resolveActor(sql: Sql, agencyId: string, userId: string | undefined): Promise<Actor> {
  const users = await loadUsers(sql, agencyId);
  const user = users.find((u) => u.id === userId) ?? users[0];
  return { agencyId, user };
}

export async function setGhlMode(sql: Sql, agencyId: string, mode: GhlMode) {
  if (!['healthy', 'rate_limited', 'outage', 'token_expired'].includes(mode)) throw new HttpError(422, 'Unknown mode');
  // "Token expired": GoHighLevel rotates the token it accepts, so ours is stale until refreshed.
  await sql`
    update agencies set ghl_mode = ${mode},
           ghl_token_version = case when ${mode} = 'token_expired' then ghl_token_version + 1 else ghl_token_version end
    where id = ${agencyId}::uuid`;
}

/**
 * Leads go first: deleting the agency in one statement cascades along two paths at once (people
 * and leads), and setting a deleted person's messages to null can collide with deleting those
 * messages' leads.
 */
export async function deleteAgency(sql: Sql, agencyId: string) {
  await sql`delete from leads where client_id in (select id from clients where agency_id = ${agencyId}::uuid)`;
  await sql`delete from agencies where id = ${agencyId}::uuid`;
}

/** Housekeeping: sandboxes nobody has opened for two weeks. */
export async function pruneAgencies(sql: Sql) {
  await sql`delete from leads where client_id in (
              select c.id from clients c join agencies a on a.id = c.agency_id where a.last_seen_at < now() - interval '14 days')`;
  const rows = await sql`delete from agencies where last_seen_at < now() - interval '14 days' returning id`;
  await sql`delete from rate_limits where window_start < now() - interval '2 days'`;
  await sql`delete from ai_usage where at < now() - interval '90 days'`;
  return rows.length;
}
