-- When each stage of a quote falls due. An ordered list of {label, percent}.
--
-- A jsonb column rather than a child table: the plan belongs to exactly one
-- document, is never queried on its own, and is always read and written whole.
-- A table would add a join, a second RLS policy and a second write path for no
-- gain. bk_invoice_items earns its table because line items are queried and
-- ordered independently; this is not.
alter table public.bk_invoices
  add column if not exists payment_plan jsonb;

comment on column public.bk_invoices.payment_plan is
  'Ordered [{label, percent}] describing when each stage of a quote is invoiced. Null means no plan.';
