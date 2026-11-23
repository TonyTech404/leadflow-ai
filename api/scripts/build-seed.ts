// Runs the real AI tasks over the demo leads once and saves the results as seed fixtures,
// so every visitor's sandbox shows genuine model output instead of hand-written scores.
//   npm run seed:build -w api      (needs ANTHROPIC_API_KEY; costs a few cents)
import { writeFile } from 'node:fs/promises';
import { runTask } from '../src/ai/provider.js';
import { draftTask, qualifyTask, toAnalysis, type LeadInput } from '../src/ai/tasks.js';
import { CAMPAIGNS, CLIENTS, LEADS } from '../src/seed/data.js';
import type { Client, LeadAnalysis } from '../../shared/types.js';

const env = { DATABASE_URL: '', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
const ctx = { env, sql: null as never, agencyId: null };

const analyses: Record<string, LeadAnalysis> = {};
const drafts: Record<string, { channel: 'sms' | 'email'; subject: string; body: string; rationale: string; facts_used: string[]; model: string }> = {};

const SENDER: Record<string, string> = { brightside: 'Priya', harbour: 'Jordan', ridgeway: 'Priya' };

async function one(def: (typeof LEADS)[number]) {
  const campaign = CAMPAIGNS.find((c) => c.key === def.campaign)!;
  const cdef = CLIENTS.find((c) => c.key === campaign.client)!;
  const client = { ...cdef, id: cdef.key, currency: 'GBP', ghl_location_id: '' } as unknown as Client;
  const input: LeadInput = {
    first_name: def.first, last_name: def.last, company: def.company ?? null, email: def.email ?? null, phone: def.phone ?? null,
    postcode: def.postcode, source: campaign.source, campaign_name: campaign.name, answers: def.answers, message: def.message,
    created_at: new Date().toISOString(),
  };
  const r = await runTask(ctx, qualifyTask(client, input, []));
  if (r.provider !== 'anthropic') throw new Error(`${def.key}: ${r.note}`);
  const a = toAnalysis(r.data, r.provider, r.model, r.ms);
  analyses[def.key] = a;
  if (def.draft) {
    const d = await runTask(ctx, draftTask(client, input, a, [], { channel: def.draft, sender: SENDER[cdef.key] }));
    if (d.provider !== 'anthropic') throw new Error(`${def.key} draft: ${d.note}`);
    drafts[def.key] = { channel: def.draft, ...d.data, model: d.model };
  }
  console.log(def.key.padEnd(5), String(a.score).padStart(3), a.priority.padEnd(6), a.intent.padEnd(18), a.summary.slice(0, 70));
}

// A few at a time, to stay well inside rate limits.
for (let i = 0; i < LEADS.length; i += 5) await Promise.all(LEADS.slice(i, i + 5).map(one));

await writeFile('src/seed/fixtures.json', JSON.stringify({ built_at: new Date().toISOString(), analyses, drafts }, null, 1) + '\n');
console.log(`saved ${Object.keys(analyses).length} analyses and ${Object.keys(drafts).length} drafts`);
