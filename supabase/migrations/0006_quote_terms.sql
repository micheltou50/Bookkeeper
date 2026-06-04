-- Standalone Terms & Conditions for quotes/invoices, stored separately from the
-- free-text notes so they can be printed on their own page at the end of the PDF.
alter table public.bk_invoices
  add column if not exists terms text;
