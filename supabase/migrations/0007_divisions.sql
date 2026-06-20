-- Additive division scoping on the EXISTING mworx Supabase setup.
--
-- Your live project already stores everything under business_id = 'mworx'
-- (profiles, invoices, expenses, jobs, OAuth, etc.). This migration does NOT
-- create a new business or move data — it only adds a division tag so the app
-- can separate Mworx Group from MT Management under the same ABN.
--
-- Safe to apply: existing rows get division = 'mworx' automatically.

alter table public.bk_transactions
  add column if not exists division text not null default 'mworx';

alter table public.bk_invoices
  add column if not exists division text not null default 'mworx';

alter table public.bk_jobs
  add column if not exists division text not null default 'mworx';

create index if not exists bk_transactions_business_division_idx
  on public.bk_transactions (business_id, division);

create index if not exists bk_invoices_business_division_idx
  on public.bk_invoices (business_id, division);

create index if not exists bk_jobs_business_division_idx
  on public.bk_jobs (business_id, division);
