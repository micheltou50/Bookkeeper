-- Dedicated OneDrive folder for expense receipts (separate from project/job folders).
-- Additive and idempotent.

alter table public.bk_profiles
  add column if not exists onedrive_receipts_folder text;

-- Seed a sensible default for the mworx business.
update public.bk_profiles
  set onedrive_receipts_folder = 'Mworx Group/Receipts'
  where business_id = 'mworx'
    and (onedrive_receipts_folder is null or onedrive_receipts_folder = '');
