-- Scope library: one row = one printed line of a quote's scope of works.
--
-- Why a new table rather than reusing bk_quote_templates: that table's row is a
-- whole quote (pricing_mode, items[], lump_amount, notes, terms) and the
-- Settings panel renders it as one. The thing that actually repeats across
-- quotes is a LINE — "Site Plan" appears in DA, CC and CDC work alike — so the
-- reusable unit has to be the line, not the document.
--
-- kind:
--   heading  a top-level line, printed as a bold bullet
--            e.g. "Production of the following documentation:"
--   item     an indented deliverable, printed as a sub-bullet
--            e.g. "Site Plan"
--   caveat   a pricing or exclusion note. Appended to the quote's NOTES, never
--            to the scope list, because the renderer bullets every scope line
--            and these were printing as bold deliverables beside "Site Plan".
--
-- Idempotent: safe to re-run.

create table if not exists public.bk_scope_lines (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  business_id   text not null,
  text          text not null,
  kind          text not null default 'item',
  category      text,
  sort_order    integer not null default 0,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.bk_scope_lines
  drop constraint if exists bk_scope_lines_kind_chk;
alter table public.bk_scope_lines
  add constraint bk_scope_lines_kind_chk check (kind in ('heading', 'item', 'caveat'));

create index if not exists bk_scope_lines_owner_idx
  on public.bk_scope_lines (user_id, business_id, archived, sort_order);

-- Same shape as bk_quote_templates_owner.
alter table public.bk_scope_lines enable row level security;
drop policy if exists bk_scope_lines_owner on public.bk_scope_lines;
create policy bk_scope_lines_owner on public.bk_scope_lines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
