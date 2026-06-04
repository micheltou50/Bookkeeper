-- Projects: elevate bk_jobs into projects with a contract value, status and a
-- link to the quote that was accepted, and link invoices/quotes to a project.
--
-- bk_jobs already has RLS enabled and is read/written by the app, so the new
-- columns inherit the existing owner policy — no new RLS needed. project_id on
-- bk_invoices is owned via the parent invoice's existing policy.

-- Projects (stored in bk_jobs) ---------------------------------------------
alter table public.bk_jobs
  add column if not exists contract_value numeric not null default 0,
  add column if not exists status text not null default 'active',
  add column if not exists accepted_quote_id uuid;

-- Link quotes/invoices to a project ----------------------------------------
alter table public.bk_invoices
  add column if not exists project_id uuid references public.bk_jobs(id) on delete set null;

create index if not exists bk_invoices_project_id_idx on public.bk_invoices(project_id);
