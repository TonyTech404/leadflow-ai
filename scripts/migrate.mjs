// Applies db/migrations/*.sql in order, once each.
//   node --env-file=.env scripts/migrate.mjs
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('db/migrations');
const url = (process.env.DATABASE_URL ?? '').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const sql = postgres(url, { max: 1, onnotice: () => {} });

await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name));

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  const body = await readFile(path.join(dir, file), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${file})`;
  });
  console.log(`applied ${file}`);
}
console.log('database is up to date');
await sql.end();
