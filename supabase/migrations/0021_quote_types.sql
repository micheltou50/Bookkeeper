-- Quote templates become "quote types": a template is keyed to a project's
-- application type (DA, CC, CDC, BIC, Drafting Only, …) so that starting a quote
-- from a project can pre-fill the scope, payment plan and notes automatically.
--
-- Why on bk_quote_templates rather than a new table: the row already holds
-- exactly what repeats per type of job (pricing_mode, items[], notes, terms).
-- The two things it lacked are WHICH kind of project it is for, and the payment
-- plan (added to bk_invoices in 0019 after this table was created).
--
-- application_type is free text matching bk_jobs.application_type. Null = a
-- general template, offered for any project.
-- Idempotent — safe to re-run.

alter table public.bk_quote_templates
  add column if not exists application_type text;

alter table public.bk_quote_templates
  add column if not exists payment_plan jsonb;

create index if not exists bk_quote_templates_apptype_idx
  on public.bk_quote_templates (user_id, business_id, application_type);
