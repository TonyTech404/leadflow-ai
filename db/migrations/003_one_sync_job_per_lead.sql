-- One outbox row per lead: enqueueing again re-uses it.
drop index if exists sync_jobs_lead;
create unique index sync_jobs_lead_unique on sync_jobs (lead_id);
