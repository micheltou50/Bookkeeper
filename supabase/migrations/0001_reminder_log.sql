-- Idempotency + audit log for automated overdue-invoice reminder emails.
-- One row per (invoice, overdue-day threshold). The unique constraint is what
-- prevents double-sends; the send-reminders function upserts on it.
--
-- NOTE: This documents the table already created in the live project. Safe to
-- re-run (idempotent).

create table if not exists public.bk_reminder_log (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.bk_invoices(id) on delete cascade,
  threshold   integer not null,                       -- 1, 7, 14, or 30
  sent_to     text,
  status      text not null default 'sending',        -- sending | sent | failed
  detail      text,
  created_at  timestamptz not null default now(),
  unique (invoice_id, threshold)
);

create index if not exists bk_reminder_log_invoice_idx
  on public.bk_reminder_log (invoice_id);

alter table public.bk_reminder_log enable row level security;

-- Written only by the service-role function; no end-user policies needed.
-- (RLS enabled with no policy = end users get no access, service role bypasses RLS.)
