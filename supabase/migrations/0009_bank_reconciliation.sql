-- Bank reconciliation: match book transactions to statement closing balance.
-- Additive and idempotent; safe to run against the live schema.

create table if not exists public.bk_reconciliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id text not null,
  statement_date date not null,
  opening_balance numeric not null default 0,
  closing_balance numeric not null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists bk_reconciliations_business_date_idx
  on public.bk_reconciliations (business_id, statement_date desc);

alter table public.bk_transactions
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation_id uuid references public.bk_reconciliations (id);

alter table public.bk_invoices
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation_id uuid references public.bk_reconciliations (id);

create index if not exists bk_transactions_reconciliation_idx
  on public.bk_transactions (reconciliation_id)
  where reconciliation_id is not null;

create index if not exists bk_invoices_reconciliation_idx
  on public.bk_invoices (reconciliation_id)
  where reconciliation_id is not null;

alter table public.bk_reconciliations enable row level security;

drop policy if exists bk_reconciliations_owner on public.bk_reconciliations;
create policy bk_reconciliations_owner on public.bk_reconciliations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
