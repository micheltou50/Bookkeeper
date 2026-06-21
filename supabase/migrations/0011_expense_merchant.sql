-- Dedicated merchant (supplier) field on expenses, so the supplier the ATO wants
-- on a record is captured separately from the free-text description. Additive and
-- idempotent. Back-fills merchant from the legacy free-text contact value.

alter table public.bk_transactions
  add column if not exists merchant text;

update public.bk_transactions
   set merchant = contact
 where merchant is null and contact is not null and contact <> '';
