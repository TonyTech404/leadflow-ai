// Who is asking, and what they may do.
//
// The public demo has no passwords: each visitor gets a sandbox agency (cookie) and can switch
// between three seeded people to see how permissions change. Every route still goes through
// these checks on the server, so swapping the demo switcher for a real identity provider only
// changes how `user` is found, not what it is allowed to do.
import type { Sql } from '../db.js';
import { forbidden, notFound } from '../lib/http.js';
import type { Role, User } from '../../../shared/types.js';

export interface Actor {
  agencyId: string;
  user: User;
}

export async function loadUsers(sql: Sql, agencyId: string): Promise<User[]> {
  return sql<User[]>`
    select u.id, u.name, u.email, u.title, u.role, u.initials,
           coalesce(array_agg(m.client_id) filter (where m.client_id is not null), '{}') as client_ids
    from users u left join memberships m on m.user_id = u.id
    where u.agency_id = ${agencyId}::uuid
    group by u.id
    order by case u.role when 'agency_admin' then 0 when 'account_manager' then 1 else 2 end, u.name`;
}

const RANK: Record<Role, number> = { client_viewer: 0, account_manager: 1, agency_admin: 2 };

export const isAdmin = (a: Actor) => a.user.role === 'agency_admin';
export const canSeeCosts = (a: Actor) => a.user.role !== 'client_viewer';

/** Client ids this person can see. */
export async function visibleClientIds(sql: Sql, a: Actor): Promise<string[]> {
  if (isAdmin(a)) {
    return (await sql<{ id: string }[]>`select id from clients where agency_id = ${a.agencyId}::uuid`).map((r) => r.id);
  }
  return a.user.client_ids;
}

/**
 * Throws unless the person can act on this client.
 * read: any member; write (work leads, approve messages): account managers and admins.
 */
export async function requireClient(sql: Sql, a: Actor, clientId: string, need: 'read' | 'write' = 'read') {
  const [c] = await sql<{ id: string }[]>`select id from clients where id = ${clientId}::uuid and agency_id = ${a.agencyId}::uuid`;
  if (!c) throw notFound('Client not found');
  if (!isAdmin(a) && !a.user.client_ids.includes(clientId)) throw forbidden('You are not on this client account.');
  if (need === 'write' && RANK[a.user.role] < RANK.account_manager) {
    throw forbidden('Client viewers can see their pipeline but not change it. Switch to an account manager to do that.');
  }
}

/** Looks up the lead's client, then applies requireClient. Returns the client id. */
export async function requireLead(sql: Sql, a: Actor, leadId: string, need: 'read' | 'write' = 'read'): Promise<string> {
  const [l] = await sql<{ client_id: string }[]>`
    select l.client_id from leads l join clients c on c.id = l.client_id
    where l.id = ${leadId}::uuid and c.agency_id = ${a.agencyId}::uuid`;
  if (!l) throw notFound('Lead not found');
  await requireClient(sql, a, l.client_id, need);
  return l.client_id;
}

export function requireAdmin(a: Actor) {
  if (!isAdmin(a)) throw forbidden('Only agency admins can change this.');
}
