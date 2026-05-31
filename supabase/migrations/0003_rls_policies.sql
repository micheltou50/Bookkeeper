-- Row Level Security policies for the core user-owned tables.
--
-- IMPORTANT: Review before applying. These assume each row has a `user_id`
-- column equal to auth.uid(). If your live policies already exist, applying
-- duplicates will error — drop/replace as appropriate. Server functions use
-- the service-role key and bypass RLS regardless.

-- Invoices ------------------------------------------------------------------
alter table public.bk_invoices enable row level security;

drop policy if exists bk_invoices_owner on public.bk_invoices;
create policy bk_invoices_owner on public.bk_invoices
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Invoice items (owned via their parent invoice) ----------------------------
alter table public.bk_invoice_items enable row level security;

drop policy if exists bk_invoice_items_owner on public.bk_invoice_items;
create policy bk_invoice_items_owner on public.bk_invoice_items
  for all
  using (exists (
    select 1 from public.bk_invoices i
    where i.id = bk_invoice_items.invoice_id and i.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bk_invoices i
    where i.id = bk_invoice_items.invoice_id and i.user_id = auth.uid()
  ));

-- Profiles ------------------------------------------------------------------
alter table public.bk_profiles enable row level security;

drop policy if exists bk_profiles_owner on public.bk_profiles;
create policy bk_profiles_owner on public.bk_profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Contacts / transactions / jobs follow the same pattern; uncomment if needed.
-- alter table public.bk_contacts     enable row level security;
-- alter table public.bk_transactions enable row level security;
-- alter table public.bk_jobs         enable row level security;
