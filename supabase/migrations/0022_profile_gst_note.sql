-- A business that is not registered for GST should say so on its documents.
-- Opt-in per business (the app serves more than one), off by default so
-- nothing changes for a business that has not made the call. Idempotent.
alter table public.bk_profiles
  add column if not exists gst_not_registered boolean not null default false;
