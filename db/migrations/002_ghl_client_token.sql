-- The token our GHL client holds, separate from the one the simulated GHL accepts, so the
-- "token expired" mode can make them differ and the client has to refresh.
alter table agencies add column ghl_client_token_version int not null default 1;
