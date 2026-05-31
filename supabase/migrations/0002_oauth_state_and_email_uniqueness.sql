-- OAuth state expiry + email-connection uniqueness.
-- Documents constraints/indexes the app relies on. Review against the live
-- schema before applying; "if not exists" guards make these safe to re-run.

-- bk_oauth_states: short-lived CSRF nonces for the Outlook OAuth flow.
-- An index on expires_at makes the periodic cleanup delete fast.
create index if not exists bk_oauth_states_expires_idx
  on public.bk_oauth_states (expires_at);

-- bk_email_connections: one connection per (user, business, provider).
-- The callback upserts on this; without the unique constraint upsert can't work.
create unique index if not exists bk_email_connections_user_biz_provider_uidx
  on public.bk_email_connections (user_id, business_id, provider);

alter table public.bk_oauth_states     enable row level security;
alter table public.bk_email_connections enable row level security;
