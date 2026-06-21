-- A statement import can be applied without a stated closing balance (you may
-- just be booking money in/out from the file). Make the closing balance optional;
-- it remains a bonus balance-check when provided. Additive + idempotent.
alter table public.bk_reconciliations alter column closing_balance drop not null;
