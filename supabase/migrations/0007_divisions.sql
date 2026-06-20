-- Division scoping for MT Management Pty Ltd operating units.
-- Both divisions share one business_id ('mworx') and ABN; division separates
-- Mworx Group (drafting/planning) from MT Management (STR property management).

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

-- Existing rows default to 'mworx' via the column default above.
