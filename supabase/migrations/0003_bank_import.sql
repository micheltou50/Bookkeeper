-- Bank statement import (CSV/OFX) support for bk_transactions.
-- Adds provenance + de-duplication columns so imported rows can be told apart
-- from manually-entered / receipt-scanned ones, and so re-importing the same
-- statement doesn't silently create duplicate expenses.
-- Additive and idempotent ("if not exists"); safe to run against the live schema.

alter table public.bk_transactions
  add column if not exists source          text not null default 'manual',
  add column if not exists bank_ref        text,
  add column if not exists import_batch_id text,
  add column if not exists dedupe_key      text,
  add column if not exists imported_at      timestamptz;

-- source:          'manual' | 'receipt' | 'bank' — where the row originated.
--                  Existing rows backfill to 'manual', which is correct for them.
-- bank_ref:        the bank's own transaction id when the file supplies one
--                  (OFX <FITID>). Lets a future live feed reconcile against it.
-- import_batch_id: groups every row that came from a single uploaded file, so an
--                  import can be reviewed or undone as a unit.
-- dedupe_key:      stable hash of date + amount + normalised description (see
--                  makeDedupeKey in src/bankImport.js). Used for soft duplicate
--                  detection — the UI flags matches but lets the user override,
--                  so this is intentionally a plain index, NOT a unique constraint
--                  (two identical same-day purchases are legitimate).
-- imported_at:     when the row was imported.

create index if not exists bk_transactions_dedupe_idx
  on public.bk_transactions (business_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists bk_transactions_import_batch_idx
  on public.bk_transactions (import_batch_id)
  where import_batch_id is not null;
