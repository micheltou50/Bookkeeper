-- Milestone 0 for the MYOB integration: make invoices reliably identifiable
-- before anything is pushed to an accounting system. Purely additive — no column
-- is dropped, renamed or retyped, and no existing value is overwritten (the
-- contact_id backfill only fills NULLs). Idempotent — safe to re-run.
--
-- Rollback is at the bottom of this file.

-- 1) Sync state on the document -------------------------------------------
-- Inert today: every row defaults to 'not_synced' and nothing writes these yet.
-- They exist now so the delete guard in step 4 has a signal to read, and so the
-- frontend can deploy independently of this (manual) migration — the insert paths
-- deliberately do NOT list these columns, they rely on the default.
alter table public.bk_invoices
  add column if not exists myob_sync_status text not null default 'not_synced',
  add column if not exists myob_synced_at   timestamptz,
  add column if not exists myob_sync_error  text;

-- 2) Document numbers are unique per division and type ---------------------
-- The Number field is free text in the UI and the next number is computed from
-- whatever the browser happens to have in memory, so duplicates were possible.
-- MYOB rejects a duplicate invoice number, so catch it at the source instead.
--
-- Blank is normalised to NULL first: '' is NOT excluded by "where number is not
-- null", so two unnumbered drafts would collide. (Verified 0 blank and 0 NULL
-- rows live at the time of writing; this is for rows created before the matching
-- frontend change ships.)
update public.bk_invoices set number = null where number is not null and btrim(number) = '';

-- IMPORTANT: the index name must not contain the substring "division".
-- sbInsert() in src/App.jsx retries an insert when the error *message* matches
-- /division/i, treating it as a pre-0007 missing column. A unique-violation
-- naming a "..._division_..." index would match that regex and be silently
-- re-inserted. (The frontend now also excludes SQLSTATE 23505 from that retry,
-- but the name stays defensive.)
create unique index if not exists bk_invoices_number_uidx
  on public.bk_invoices (business_id, division, type, number)
  where number is not null;

-- 3) Link each document to its saved contact -------------------------------
-- bk_invoices.contact_id has always existed with a foreign key, but nothing ever
-- wrote it — all 22 live rows were NULL. Documents keep their contact SNAPSHOT
-- (contact_name/email/company/abn/…) as the record of what was printed; the id is
-- the stable link the accounting sync needs so it doesn't create a duplicate
-- customer per invoice.
--
-- Three passes, mirroring contactIdFor() in src/App.jsx, each requiring exactly
-- one match (bk_contacts has no uniqueness on name, and picking an arbitrary row
-- would be worse than leaving the link empty):
--   a) the picker's own key, coalesce(nullif(name,''), company)
--   b) company name  — recovers rows that stored the company as the contact name
--   c) email         — recovers rows that stored a shortened name
-- Rows that match nothing are left NULL by design; the migration never fails on
-- an unmatched row.

-- a) exact match on the display key the contact picker writes
update public.bk_invoices i
   set contact_id = c.id
  from public.bk_contacts c
 where i.contact_id is null
   and c.business_id = i.business_id
   and lower(btrim(coalesce(nullif(c.name, ''), c.company))) = lower(btrim(i.contact_name))
   and btrim(coalesce(i.contact_name, '')) <> ''
   and (select count(*) from public.bk_contacts c2
         where c2.business_id = i.business_id
           and lower(btrim(coalesce(nullif(c2.name, ''), c2.company))) = lower(btrim(i.contact_name))) = 1;

-- b) the document stored a company name (e.g. "Enspect Pty Ltd" where the
--    contact's display key is "Nick Papouttsakis")
update public.bk_invoices i
   set contact_id = c.id
  from public.bk_contacts c
 where i.contact_id is null
   and c.business_id = i.business_id
   and lower(btrim(c.company)) = lower(btrim(i.contact_name))
   and btrim(coalesce(i.contact_name, '')) <> ''
   and (select count(*) from public.bk_contacts c2
         where c2.business_id = i.business_id
           and lower(btrim(c2.company)) = lower(btrim(i.contact_name))) = 1;

-- c) fall back to the email on the document (e.g. contact_name "Michel")
update public.bk_invoices i
   set contact_id = c.id
  from public.bk_contacts c
 where i.contact_id is null
   and c.business_id = i.business_id
   and lower(btrim(c.email)) = lower(btrim(i.contact_email))
   and btrim(coalesce(i.contact_email, '')) <> ''
   and (select count(*) from public.bk_contacts c2
         where c2.business_id = i.business_id
           and lower(btrim(c2.email)) = lower(btrim(i.contact_email))) = 1;

create index if not exists bk_invoices_contact_idx on public.bk_invoices(contact_id);

-- 4) A document that reached MYOB can't be deleted here ---------------------
-- Enforced as a BEFORE DELETE trigger, NOT as an RLS predicate. An RLS-filtered
-- DELETE removes zero rows and returns NO error, so supabase-js reports success
-- and the app would drop the row from the UI while it still exists in the
-- database. A raised exception surfaces as a real failure the user can read.
create or replace function public.bk_block_delete_synced_invoice()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(old.myob_sync_status, 'not_synced') <> 'not_synced' then
    raise exception
      '% % is recorded in MYOB and cannot be deleted. Reverse or credit it in MYOB first.',
      initcap(coalesce(old.type, 'document')), coalesce(old.number, old.id::text)
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists bk_invoices_block_delete_synced on public.bk_invoices;
create trigger bk_invoices_block_delete_synced
  before delete on public.bk_invoices
  for each row execute function public.bk_block_delete_synced_invoice();

-- ---------------------------------------------------------------------------
-- ROLLBACK (paste to undo this migration completely):
--
--   drop trigger if exists bk_invoices_block_delete_synced on public.bk_invoices;
--   drop function if exists public.bk_block_delete_synced_invoice();
--   drop index  if exists public.bk_invoices_number_uidx;
--   drop index  if exists public.bk_invoices_contact_idx;
--   update public.bk_invoices set contact_id = null;
--   alter table public.bk_invoices
--     drop column if exists myob_sync_status,
--     drop column if exists myob_synced_at,
--     drop column if exists myob_sync_error;
-- ---------------------------------------------------------------------------
