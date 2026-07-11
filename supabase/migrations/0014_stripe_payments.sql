-- Stripe card payments for invoices.
-- Additive columns on bk_invoices (no new table): a per-invoice un-guessable
-- pay_token for the public pay link, and fields the webhook fills when a card
-- payment succeeds. Idempotency is enforced by the stripe_session_id unique
-- index + the webhook's "... where stripe_session_id is null" guard.
--
-- Safe to re-run (idempotent). Applied manually via Supabase MCP.

-- Un-guessable token embedded in every pay link. Backfill existing rows, then
-- set a default so new invoices auto-get one (the frontend never writes it —
-- ALLOWED_INVOICE_COLS in App.jsx excludes it, so the DB default fills it).
alter table public.bk_invoices add column if not exists pay_token uuid;
update public.bk_invoices set pay_token = gen_random_uuid() where pay_token is null;
alter table public.bk_invoices alter column pay_token set default gen_random_uuid();

-- Written by stripe-webhook (service role) when a Checkout Session completes.
alter table public.bk_invoices add column if not exists stripe_session_id text;
alter table public.bk_invoices add column if not exists paid_amount numeric;      -- total actually charged (base + surcharge), dollars
alter table public.bk_invoices add column if not exists surcharge_amount numeric; -- card surcharge portion, dollars

-- Uniqueness only applies to real ids (Postgres allows many NULLs), so this
-- doubles as an idempotency backstop without blocking un-paid invoices.
create unique index if not exists bk_invoices_stripe_session_uidx
  on public.bk_invoices (stripe_session_id);

-- Owner RLS already on bk_invoices covers reads of these columns; the webhook
-- writes via the service role (bypasses RLS). No new policy needed.
