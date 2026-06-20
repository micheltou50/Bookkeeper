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
  `division = 'mworx'`. Required before saving MT Management records; Mworx
  Group keeps working without it (the app omits division on insert until applied).

## Applying

These are NOT auto-applied. Apply via the Supabase SQL editor or CLI after
reviewing. Server functions use the service-role key and bypass RLS, so the
backend keeps working regardless; RLS protects direct client/browser access.
