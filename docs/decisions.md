# Decisions

Short records of the choices that shaped the prototype, and what I would revisit for production.

## 1. A simulated GoHighLevel, built to the real API

**Context.** GoHighLevel needs an agency account and a marketplace app, and a reviewer can't see inside my CRM anyway.

**Decision.** Write the client against the LeadConnector v2 API, then run it against a simulation of those endpoints that I control. The simulation enforces the parts that matter: the version header, rotating tokens, upsert semantics and opportunity search.

**Why.** The difficult part of a CRM integration isn't the happy path. It is rate limits, expired tokens, and requests whose reply is lost. A simulation can produce those failures on demand (the failure lab), so they can be shown and tested.

**Production.** Swap the transport for `fetch`, add the OAuth install flow, and verify webhooks with GHL's public key.

## 2. An outbox for CRM writes

**Decision.** Never call the CRM inline with a user action. Write a `sync_jobs` row; a runner claims it with a short lease, works through it, and logs every attempt.

**Why.**
- A user action never fails because the CRM is down.
- Retries survive restarts.
- Every attempt is visible to support staff.
- One job per lead stops two clicks from racing.

## 3. Search before create after an uncertain failure

**Decision.** After a timeout or a 500, the next attempt searches for the opportunity by contact before creating one.

**Why.** Opportunities in GHL have no idempotency key. A timeout can mean "not created" or "created, but the reply was lost". Searching first turns that into a safe retry. Contacts don't need this, because upsert is idempotent. An integration test drops a reply after the create succeeds and checks there is still only one opportunity.

## 4. People approve every outbound message

**Decision.** AI drafts land as `draft` messages. Sending needs a person to click Approve. Drafts must not invent prices or offers, and each one lists the facts it used.

**Why.** For an agency, a wrong message to a client's customer costs more than a few minutes of delay. The approval step is cheap, and the "facts used" list makes review fast. Auto-send could later be enabled per automation, for low-risk templates.

## 5. The model scores; code decides the priority

**Decision.** Claude returns a score with reasons. Code clamps the score and maps it to a priority: 70 and above is hot, 40 and above is warm.

**Why.** Thresholds stay fixed and testable, and the automations ("if priority is high") stay predictable. The model's job is the judgement: reading free text and form answers against the client's ideal customer.

## 6. Structured output plus a labelled fallback

**Decision.** Use Zod schemas as the output format, validate the result, and fall back to deterministic rules on failure. The UI says which one produced each result.

**Why.** The demo must keep working when a limit is hit, and must never pass rules off as AI. The same rules make the CI tests deterministic.

## 7. One sandbox per visitor

**Decision.** The first request creates a private agency, seeded with fictional data, and sets a cookie. Sandboxes nobody has opened for 14 days are deleted.

**Why.** Reviewers can change anything — approve, drag, break the CRM — without seeing each other's changes. The seeding also runs the real multi-tenant code path on every visit.

## 8. Hono, SQL and Cloudflare instead of NestJS, Prisma and AWS

See the README section *Why not NestJS, Prisma and AWS?*. In short:
- **Hono:** portable between Workers and Node.
- **SQL:** the data work here is SQL-shaped.
- **Cloudflare and Neon:** free hosting with nothing to run.

The service boundaries would map onto NestJS modules, and the Worker sits in AWS London already.

## 9. Scheduled work from GitHub Actions

**Decision.** A GitHub Actions workflow calls `POST /api/cron` every 15 minutes, protected by a secret header.

**Why.** The Cloudflare account's cron trigger slots are used by other projects. The endpoint is idempotent and bounded (20 jobs per call), so the caller is easy to swap for a Cron Trigger or EventBridge later.
