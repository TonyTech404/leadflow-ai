import { useEffect, useState } from 'react';
import type { Client } from '../../../shared/types';
import { api } from '../lib/api';
import { useSession } from '../session';
import { PageHeader } from '../components/ui';

interface Spec {
  info: { description: string };
  paths: Record<string, Record<string, { summary: string; description?: string; responses: Record<string, { description: string }> }>>;
}

export function ApiDocsPage() {
  const { session } = useSession();
  const [spec, setSpec] = useState<Spec | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [sig, setSig] = useState<{ body: string; signature: string } | null>(null);
  useEffect(() => {
    api<Spec>('/openapi.json').then(setSpec);
    api<{ body: string; signature: string }>('/webhooks/sign').then(setSig);
    if (session?.clients[0]) api<{ client: Client }>(`/clients/${session.clients[0].id}`).then((r) => setClient(r.client));
  }, [session]);
  const origin = window.location.origin;
  const key = client?.api_key ?? '<client api key>';

  return (
    <div className="max-w-[900px] space-y-8">
      <PageHeader title="Public API" sub={spec?.info.description} actions={<a className="btn btn-quiet" href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a>} />

      <section className="space-y-2">
        <h2 className="font-semibold">Send a lead</h2>
        <p className="text-ink-2">Any form, landing page or ad platform can post leads. They are qualified by AI in the background and run through the client's automations.</p>
        <pre className="overflow-x-auto rounded-lg bg-navy p-4 text-[12.5px] leading-relaxed text-white">{`curl -X POST ${origin}/api/v1/leads \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "first_name": "Helen", "last_name": "Ward",
    "phone": "07700 900123", "postcode": "SK4 3BT",
    "utm_campaign": "winter-energy-bills",
    "answers": { "Homeowner": "Yes", "Timeline": "Within 3 months" },
    "message": "Want panels and a battery before spring."
  }'`}</pre>
        {client?.api_key ? (
          <p className="text-[12.5px] text-ink-3">This is {client.name}'s real key in your sandbox, so the command above works.</p>
        ) : (
          <p className="text-[12.5px] text-ink-3">Switch to an agency admin or account manager to see a key.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Receive CRM events</h2>
        <p className="text-ink-2">
          POST /api/v1/webhooks/ghl accepts GoHighLevel-style events. Each one must carry <code>x-leadflow-signature: sha256=&lt;HMAC of the raw body&gt;</code>; events
          already seen (same webhookId) are acknowledged and ignored. Real GoHighLevel webhooks are verified with GHL's public key instead, which only changes the verifier.
        </p>
        {sig && <pre className="overflow-x-auto rounded-lg bg-navy p-4 text-[12.5px] leading-relaxed text-white">{`x-leadflow-signature: ${sig.signature}\n\n${sig.body}`}</pre>}
      </section>

      <section>
        <h2 className="mb-3 font-semibold">Endpoints</h2>
        <ul className="panel divide-y divide-line">
          {spec &&
            Object.entries(spec.paths).flatMap(([path, ops]) =>
              Object.entries(ops).map(([method, op]) => (
                <li key={method + path} className="px-4 py-3">
                  <p className="font-medium">
                    <span className="mr-2 rounded bg-blue-wash px-1.5 py-0.5 text-[12px] font-semibold uppercase text-blue">{method}</span>
                    <code>/api{path}</code> <span className="text-ink-2">{op.summary}</span>
                  </p>
                  {op.description && <p className="mt-1 text-[13px] text-ink-2">{op.description}</p>}
                  <p className="mt-1 text-[12.5px] text-ink-3">
                    {Object.entries(op.responses).map(([code, r]) => `${code} ${r.description}`).join('; ')}
                  </p>
                </li>
              )),
            )}
        </ul>
      </section>
    </div>
  );
}
