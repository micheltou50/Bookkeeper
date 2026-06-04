-- Lump-sum pricing: a quote/invoice can either be itemised (Description × Qty ×
-- Rate, total = sum) or a lump sum (a scope of works listed as description-only
-- rows with a single agreed Total typed directly). Scope rows still live in
-- bk_invoice_items (description only); the total is stored on bk_invoices.total.

alter table public.bk_invoices
  add column if not exists pricing_mode text not null default 'itemised';
