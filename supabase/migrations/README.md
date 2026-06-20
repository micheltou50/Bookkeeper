# Supabase migrations

These SQL files document the schema/constraints/RLS the app relies on.

- `0001_reminder_log.sql` — **already applied** to the live project (the
  `bk_reminder_log` table exists). Kept for reference and fresh setups.
- `0002_oauth_state_and_email_uniqueness.sql` — indexes + the unique
  constraint the Outlook OAuth upsert needs. **Review before applying.**
- `0003_rls_policies.sql` — Row Level Security policies. **Review carefully**
  against existing live policies before applying — duplicates will error.
- `0007_divisions.sql` — `division` column on `bk_transactions`, `bk_invoices`,
  and `bk_jobs` for Mworx Group / MT Management scoping. **Apply before using
  the division switcher** — existing rows default to `mworx`.

## Applying

These are NOT auto-applied. Apply via the Supabase SQL editor or CLI after
reviewing. Server functions use the service-role key and bypass RLS, so the
backend keeps working regardless; RLS protects direct client/browser access.
