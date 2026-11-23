// GoHighLevel (LeadConnector v2) client.
//
// Takes a transport, anything that turns a Request into a Response, so the same code runs
// against the in-app simulation or, with `fetch`, the real API at services.leadconnectorhq.com.

export type Transport = (req: Request) => Promise<Response>;

export type GhlErrorKind =
  | 'rate_limited' // 429: nothing was written; wait and retry
  | 'unavailable' //  502/503/504: nothing was written; retry with backoff
  | 'timeout' //      no response: the request may or may not have been applied
  | 'server' //       500: may or may not have been applied
  | 'auth' //         401: access token expired or revoked; refresh and retry once
  | 'validation' //   400/422: retrying will not help
  | 'not_found';

export class GhlError extends Error {
  constructor(
    readonly kind: GhlErrorKind,
    readonly status: number | null,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get transient() {
    return ['rate_limited', 'unavailable', 'timeout', 'server'].includes(this.kind);
  }
  /** The request may have been applied even though no success came back. */
  get uncertain() {
    return this.kind === 'timeout' || this.kind === 'server';
  }
}

export interface GhlConfig {
  baseUrl: string;
  locationId: string;
  version: string;
  timeoutMs: number;
  getToken: () => Promise<string>;
}

export interface ContactInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  source: string;
  tags: string[];
  customFields: { key: string; field_value: string }[];
}

export interface Opportunity {
  id: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  status: 'open' | 'won' | 'lost' | 'abandoned';
  monetaryValue: number | null;
}

export class GhlClient {
  constructor(
    private readonly transport: Transport,
    private readonly config: GhlConfig,
  ) {}

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.config.getToken();
    const req = new Request(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: this.config.version,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let res: Response;
    try {
      res = await withTimeout(this.transport(req), this.config.timeoutMs);
    } catch (e) {
      throw new GhlError('timeout', null, e instanceof TimeoutError ? e.message : `Connection failed: ${(e as Error).message}`);
    }
    if (res.ok) return res;

    const text = await res.text();
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      /* not JSON */
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after') ?? 1) * 1000;
      throw new GhlError('rate_limited', 429, message, after);
    }
    if (res.status === 401) throw new GhlError('auth', 401, message);
    if (res.status === 404) throw new GhlError('not_found', 404, message);
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new GhlError('unavailable', res.status, message);
    if (res.status >= 500) throw new GhlError('server', res.status, message);
    throw new GhlError('validation', res.status, message);
  }

  /** Creates or updates a contact, matched on email or phone. Safe to repeat. */
  async upsertContact(input: ContactInput): Promise<{ id: string; created: boolean }> {
    const res = await this.send('POST', '/contacts/upsert', { locationId: this.config.locationId, ...input });
    const data = (await res.json()) as { new: boolean; contact: { id: string } };
    return { id: data.contact.id, created: data.new };
  }

  async findOpportunities(contactId: string): Promise<Opportunity[]> {
    const q = new URLSearchParams({ location_id: this.config.locationId, contact_id: contactId });
    const res = await this.send('GET', `/opportunities/search?${q}`);
    return ((await res.json()) as { opportunities: Opportunity[] }).opportunities;
  }

  async createOpportunity(input: Omit<Opportunity, 'id'> & { name: string }): Promise<Opportunity> {
    const res = await this.send('POST', '/opportunities/', { locationId: this.config.locationId, ...input });
    return ((await res.json()) as { opportunity: Opportunity }).opportunity;
  }

  async updateOpportunity(id: string, patch: Partial<Pick<Opportunity, 'pipelineStageId' | 'status' | 'monetaryValue'>>): Promise<Opportunity> {
    const res = await this.send('PUT', `/opportunities/${id}`, patch);
    return ((await res.json()) as { opportunity: Opportunity }).opportunity;
  }
}

/** POST /oauth/token with a refresh token. Returns the new access token. */
export async function refreshAccessToken(transport: Transport, baseUrl: string, refreshToken: string, timeoutMs: number): Promise<string> {
  const req = new Request(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const res = await withTimeout(transport(req), timeoutMs);
  if (!res.ok) throw new GhlError('auth', res.status, 'Token refresh failed; the connection needs to be re-authorised.');
  return ((await res.json()) as { access_token: string }).access_token;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`No response from GoHighLevel within ${(ms / 1000).toFixed(1)}s`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
