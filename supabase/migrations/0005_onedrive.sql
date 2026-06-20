-- OneDrive integration: per-business setting for the OneDrive folder that holds
-- the job folders (e.g. "Mworx Group"). Invoice PDFs and receipts are saved into
-- the matching "<job_number> - ..." subfolder via Microsoft Graph. Additive.

alter table public.bk_profiles add column if not exists onedrive_folder text;

-- Seed the known folder for the mworx business (the app falls back to this anyway).
update public.bk_profiles set onedrive_folder = 'Mworx Group'
  where business_id = 'mworx' and (onedrive_folder is null or onedrive_folder = '');
