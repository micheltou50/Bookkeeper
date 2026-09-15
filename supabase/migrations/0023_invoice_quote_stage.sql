-- Which stage of the accepted quote's payment plan an invoice bills (1-based).
-- Pairs with converted_from_quote_id (already present). The deposit-on-accept
-- invoice is stage 1; later stages are picked from a dropdown on the invoice
-- form, which hides stages that already have an invoice. Rows with a quote link
-- but no stage predate this column and are treated as stage 1. Idempotent.
alter table public.bk_invoices
  add column if not exists quote_stage integer;
