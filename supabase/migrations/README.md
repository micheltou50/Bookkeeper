# Supabase migrations

These SQL files document the schema/constraints/RLS the app relies on.

- `0001_reminder_log.sql` — **already applied** to the live project (the
  `bk_reminder_log` table exists). Kept for reference and fresh setups.
- `0002_oauth_state_and_email_uniqueness.sql` — indexes + the unique
  constraint the Outlook OAuth upsert needs. **Review before applying.**
- `0003_rls_policies.sql` — Row Level Security policies. **Review carefully**
  against existing live policies before applying — duplicates will error.
- `0007_divisions.sql` — Adds a `division` column on top of the existing
  `business_id = 'mworx'` setup. All current Mworx data is backfilled to
  `division = 'mworx'`. **Required before saving MT Management records**; Mworx
  Group keeps working without it (the app omits division on insert until applied).
- `0008_standardise_division_slug.sql` — Renames legacy `mtmgmt` rows to
  `mt_management`. Apply after 0007.
- `0009_bank_reconciliation.sql` — Bank reconciliation table
  (`bk_reconciliations`) plus `reconciled_at` / `reconciliation_id` on
  `bk_transactions` and `bk_invoices`. **Required for Bank Reconciliation**
  in the app.
- `0010_onedrive_receipts_folder.sql` — Adds `onedrive_receipts_folder` on
  `bk_profiles` for a dedicated OneDrive receipts path (separate from project
  folders). **Required before saving the receipts folder setting.**

## Urgent: apply 0007–0010 to live project

Project `yzndkdlzgegrcotfeqlp` — paste migrations in order (`0007` through `0010`) into
the [Supabase SQL editor](https://supabase.com/dashboard/project/yzndkdlzgegrcotfeqlp/sql/new),
or run `node scripts/apply-supabase-migrations.mjs` with `SUPABASE_SERVICE_KEY`
(and optionally `SUPABASE_DB_URL`) in `.env`.

## Applying

These are NOT auto-applied. Apply via the Supabase SQL editor or CLI after
reviewing. Server functions use the service-role key and bypass RLS, so the
backend keeps working regardless; RLS protects direct client/browser access.
