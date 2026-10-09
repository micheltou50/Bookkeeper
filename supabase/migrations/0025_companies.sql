-- Companies: promote the hard-coded "divisions" (Mworx Group / MT Management)
-- into editable company records, so each company carries its own logo, ABN,
-- bank account, email templates, document prefixes and colour, and new
-- companies can be added from Settings.
--
-- Model: bk_profiles holds ONE ROW PER COMPANY, keyed by business_id = the
-- company slug — the same value quotes, invoices and projects carry in their
-- `division` column (0007). Those document/project rows keep business_id =
-- 'mworx' as the tenant key; for them it never meant "company". So the Mworx
-- Group profile is business_id 'mworx', MT Management's is 'mt_management',
-- and an MT Management invoice has business_id 'mworx', division
-- 'mt_management'. Server functions look a document's company up through
-- netlify/functions/lib/company.mjs. Idempotent.

alter table public.bk_profiles
  add column if not exists short_name text,
  add column if not exists subtitle text,
  add column if not exists tagline text,
  add column if not exists accent text,
  add column if not exists invoice_prefix text,
  add column if not exists quote_prefix text,
  add column if not exists sort_order integer not null default 0,
  add column if not exists archived boolean not null default false;

-- The legacy 'mt' stub (from before divisions existed) becomes the MT
-- Management company, unless the user already has an mt_management row.
update public.bk_profiles p
   set business_id = 'mt_management'
 where p.business_id = 'mt'
   and not exists (
     select 1 from public.bk_profiles q
      where q.user_id = p.user_id and q.business_id = 'mt_management');

-- Every user with a Mworx Group profile also gets an MT Management row (the
-- app has offered that division since 0007; it just had nowhere to keep its
-- own details).
insert into public.bk_profiles (user_id, business_id, name)
select p.user_id, 'mt_management', 'MT Management'
  from public.bk_profiles p
 where p.business_id = 'mworx'
   and not exists (
     select 1 from public.bk_profiles q
      where q.user_id = p.user_id and q.business_id = 'mt_management');

-- Seed the identity that used to live in code. coalesce() so re-running never
-- overwrites what has since been edited in Settings. The accents are the
-- colours the PDFs already print in (src/lib/doc-html.mjs DIVISION_META), so
-- existing documents look exactly the same after this.
update public.bk_profiles set
  name           = coalesce(nullif(name, ''), 'Mworx Group'),
  short_name     = coalesce(short_name, 'Mworx'),
  subtitle       = coalesce(subtitle, 'Drafting & planning'),
  tagline        = coalesce(tagline, 'Design · Consultancy · Project Management'),
  accent         = coalesce(accent, '#0d9488'),
  invoice_prefix = coalesce(invoice_prefix, 'MWX'),
  quote_prefix   = coalesce(quote_prefix, 'QMWX')
where business_id = 'mworx';

update public.bk_profiles set
  name           = coalesce(nullif(name, ''), 'MT Management'),
  short_name     = coalesce(short_name, 'MT Mgmt'),
  subtitle       = coalesce(subtitle, 'STR property management'),
  tagline        = coalesce(tagline, 'Short-Term Rental Property Management'),
  accent         = coalesce(accent, '#2563eb'),
  invoice_prefix = coalesce(invoice_prefix, 'MTM'),
  quote_prefix   = coalesce(quote_prefix, 'QMTM'),
  sort_order     = greatest(sort_order, 1)
where business_id = 'mt_management';
