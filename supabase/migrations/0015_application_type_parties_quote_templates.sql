-- Projects get an application type (DA, CC, CDC, S4.55, Drafting Only, …),
-- explicit clients/consultants attached up-front (bk_job_parties), and reusable
-- quote templates (bk_quote_templates). Idempotent — safe to re-run.

-- 1) Application type on projects ------------------------------------------
alter table public.bk_jobs
  add column if not exists application_type text;

-- 2) Project parties: many clients/consultants per project ------------------
create table if not exists public.bk_job_parties (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.bk_jobs(id) on delete cascade,
  contact_id  uuid not null references public.bk_contacts(id) on delete cascade,
  role        text not null default 'client',        -- client | consultant
  created_at  timestamptz not null default now(),
  unique (job_id, contact_id)
);

create index if not exists bk_job_parties_job_idx on public.bk_job_parties(job_id);

alter table public.bk_job_parties enable row level security;

drop policy if exists bk_job_parties_owner on public.bk_job_parties;
create policy bk_job_parties_owner on public.bk_job_parties
  for all
  using (exists (
    select 1 from public.bk_jobs j
    where j.id = bk_job_parties.job_id and j.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bk_jobs j
    where j.id = bk_job_parties.job_id and j.user_id = auth.uid()
  ));

-- Backfill: projects that already have a single linked contact keep it as a party.
insert into public.bk_job_parties (job_id, contact_id, role)
select j.id, j.contact_id,
       case when c.type = 'consultant' then 'consultant' else 'client' end
from public.bk_jobs j
join public.bk_contacts c on c.id = j.contact_id
where j.contact_id is not null
on conflict (job_id, contact_id) do nothing;

-- 3) Quote templates ---------------------------------------------------------
create table if not exists public.bk_quote_templates (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  business_id   text not null,
  name          text not null,
  pricing_mode  text not null default 'itemised',    -- itemised | lump_sum
  items         jsonb not null default '[]'::jsonb,  -- [{description, qty, rate, note}]
  lump_amount   numeric,
  notes         text,
  terms         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists bk_quote_templates_owner_idx
  on public.bk_quote_templates(user_id, business_id);

alter table public.bk_quote_templates enable row level security;

drop policy if exists bk_quote_templates_owner on public.bk_quote_templates;
create policy bk_quote_templates_owner on public.bk_quote_templates
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
