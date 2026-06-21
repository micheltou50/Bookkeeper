-- Learned expense categorisation. Every time the user categorises an expense we
-- remember "merchant keyword -> category", so future expenses (imports, receipt
-- scans, manual entry) default to the user's own past choice. Account-wide
-- (one ABN / one account); keyed per business by a normalised keyword.

create table if not exists public.bk_category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  business_id text not null,
  keyword text not null,
  category text not null,
  hits integer not null default 1,
  updated_at timestamptz not null default now(),
  unique (business_id, keyword)
);

alter table public.bk_category_rules enable row level security;

drop policy if exists bk_category_rules_sel on public.bk_category_rules;
create policy bk_category_rules_sel on public.bk_category_rules for select using (user_id = auth.uid());
drop policy if exists bk_category_rules_ins on public.bk_category_rules;
create policy bk_category_rules_ins on public.bk_category_rules for insert with check (user_id = auth.uid());
drop policy if exists bk_category_rules_upd on public.bk_category_rules;
create policy bk_category_rules_upd on public.bk_category_rules for update using (user_id = auth.uid());
drop policy if exists bk_category_rules_del on public.bk_category_rules;
create policy bk_category_rules_del on public.bk_category_rules for delete using (user_id = auth.uid());
