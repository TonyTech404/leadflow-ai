// Inbound CRM webhooks, GoHighLevel style.
//
// Each delivery is verified (HMAC-SHA256 of the raw body, compared in constant time) and
// recorded by event id, so a retried delivery is acknowledged without being applied twice.
// Real GoHighLevel webhooks are verified against GHL's published public key; this demo signs its
// simulated events with a shared secret instead. The verifier is the only part that changes.
import type { Sql } from '../db.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/http.js';
import { draftFollowUp, logActivity } from './leads.js';

const DEMO_SECRET = 'leadflow-demo-webhook-secret';

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signWebhook(env: Env, body: string) {
  return `sha256=${await hmac(env.WEBHOOK_SECRET ?? DEMO_SECRET, body)}`;
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface InboundEvent {
  type: string;
  webhookId: string;
  locationId: string;
  contactId: string;
  messageType?: 'SMS' | 'Email';
  body?: string;
  dateAdded?: string;
}

export async function handleGhlWebhook(sql: Sql, env: Env, raw: string, signature: string) {
  if (!safeEqual(signature, await signWebhook(env, raw))) throw new HttpError(401, 'Invalid signature');
  let event: InboundEvent;
  try {
    event = JSON.parse(raw) as InboundEvent;
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
  if (!event.webhookId || !event.locationId || !event.type) throw new HttpError(422, 'webhookId, locationId and type are required');

  const [client] = await sql<{ id: string; agency_id: string }[]>`select id, agency_id from clients where ghl_location_id = ${event.locationId}`;
  if (!client) throw new HttpError(404, 'Unknown location');

  const [fresh] = await sql`
    insert into webhook_events (agency_id, provider, event_id, type, payload)
    values (${client.agency_id}::uuid, 'ghl', ${event.webhookId}, ${event.type}, ${sql.json(event as never)})
    on conflict (agency_id, provider, event_id) do nothing returning id`;
  if (!fresh) return { duplicate: true, leadId: null, followUp: null };

  if (event.type !== 'InboundMessage' || !event.body) return { duplicate: false, leadId: null, followUp: null };
  const [lead] = await sql<{ id: string }[]>`select id from leads where client_id = ${client.id}::uuid and ghl_contact_id = ${event.contactId}`;
  if (!lead) return { duplicate: false, leadId: null, followUp: null };

  const channel = event.messageType === 'Email' ? 'email' : 'sms';
  await sql`insert into messages (lead_id, direction, channel, status, body) values (${lead.id}::uuid, 'inbound', ${channel}, 'received', ${event.body.slice(0, 2000)})`;
  await logActivity(sql, lead.id, 'system', 'reply', `New ${channel === 'sms' ? 'SMS' : 'email'} reply, received through the GoHighLevel webhook.`);

  return {
    duplicate: false,
    leadId: lead.id,
    // Suggest a reply for a person to review.
    followUp: async (s: Sql) => {
      await draftFollowUp(s, env, lead.id, { channel, createdBy: null, actorName: 'automation' });
    },
  };
}

/** Builds and signs a GHL-style "InboundMessage" event for a synced lead, then handles it. */
export async function simulateInboundReply(sql: Sql, env: Env, leadId: string, body?: string) {
  const [l] = await sql<{ ghl_contact_id: string | null; ghl_location_id: string; phone: string | null }[]>`
    select l.ghl_contact_id, c.ghl_location_id, l.phone from leads l join clients c on c.id = l.client_id where l.id = ${leadId}::uuid`;
  if (!l.ghl_contact_id) throw new HttpError(409, 'Sync this lead to GoHighLevel first; replies arrive through the CRM.');
  const event: InboundEvent = {
    type: 'InboundMessage',
    webhookId: `evt_${crypto.randomUUID()}`,
    locationId: l.ghl_location_id,
    contactId: l.ghl_contact_id,
    messageType: l.phone ? 'SMS' : 'Email',
    body: body?.trim() || 'Thanks for getting back to me. Could we do later this week? And roughly what would it cost?',
    dateAdded: new Date().toISOString(),
  };
  const raw = JSON.stringify(event);
  return handleGhlWebhook(sql, env, raw, await signWebhook(env, raw));
}
