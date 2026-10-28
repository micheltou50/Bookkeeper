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
- `0027_inbox.sql` — `bk_inbox_items` + `bk_inbox_runs` (owner RLS). The
  scheduled Claude email runs write here; the Inbox page reads it. Additive and
  idempotent. **Required for the Inbox page** — without it the page shows a
  setup notice and the nav badge stays empty.
- `0028_inbox_focus.sql` — `focus boolean` on `bk_inbox_items` (the Focus list:
  pinned / taken out / undecided) and widens the `kind` check with `proposal`
  and `task`. Additive and re-runnable. **Required for pinning and "Add a
  task"** — without it the page still works on the auto rules, but those two
  actions show a "needs migration 0028" notice.
- `0029_draft_quote.sql` — `bk_draft_quote_from_proposal(item_id, application_type,
  works, amount, template_id, client_company)`: turns a `proposal` Inbox item
  into a draft quote the way the app does (next number, quote-type scope, client
  and lead job linked or created) and links it on the item. Called by the runs
  and by the Inbox page's "Draft quote". Re-runnable.
- `0030_inbox_follow_invoice.sql` — trigger on `bk_invoices`: a quote sent /
  accepted marks its `proposal` item done (declined → dismissed); an invoice
  sent / paid marks its `money` item done (superseded / cancelled →
  dismissed). Status changes only, open items linked by `invoice_id` only.
  Re-runnable.
- `0031_inbox_run_writes.sql` — `bk_inbox_open_run`, `bk_inbox_write_items`,
  `bk_inbox_mark_done`, `bk_inbox_close_run`: every write the scheduled runs
  make, as functions called with SELECT. The Supabase connector stops raw
  UPDATE / upsert statements for a confirmation a scheduled run cannot give
  (the 27 Oct close-off wrote nothing because of it). Re-runnable.
- `0032_inbox_quality.sql` — `bk_inbox_items.file_link` (OneDrive link of a
  filed file), `bk_inbox_runs.qa` and `bk_inbox_run_qa` (the run's own
  verification list as its last write — completed / partial / failed per
  action; moves an `ok` run to `partial` when anything is not completed), and
  `bk_inbox_write_items` clearing a link passed as JSON null. Re-runnable, no
  drops.
- `0033_inbox_api.sql` — `bk_inbox_api_keys` (sha256 of the bearer keys the
  scheduled runs present to `netlify/functions/inbox-api.mjs`; RLS with no
  policies, service role only) and `bk_inbox_api_key_issue(user, label)`,
  which makes a key, stores its hash here and the key in Vault as
  `inbox_api_key`, revokes earlier keys and prints nothing. Re-runnable.
- `0034_job_numbers_and_quotes.sql` — `bk_next_job_number(business, division)`
  (Mworx Energy `YY1###` from `YY1001`, every other company `YY###` from
  `YY101`), the `bk_jobs_number_guard` before-insert trigger (assigns a
  missing number, corrects a purely numeric number of the wrong length for
  its company, refuses a duplicate with a plain message) and
  `bk_draft_quote_from_proposal` re-created so every proposal item gets its
  own draft and no fee is assumed (BASIX always 0; `p_amount` ignored).
  Re-runnable, no drops.

## Urgent: apply 0007–0010 to live project

Project `yzndkdlzgegrcotfeqlp` — paste migrations in order (`0007` through `0010`) into
the [Supabase SQL editor](https://supabase.com/dashboard/project/yzndkdlzgegrcotfeqlp/sql/new),
or run `node scripts/apply-supabase-migrations.mjs` with `SUPABASE_SERVICE_KEY`
(and optionally `SUPABASE_DB_URL`) in `.env`.

## Applying

These are NOT auto-applied. Apply via the Supabase SQL editor or CLI after
reviewing. Server functions use the service-role key and bypass RLS, so the
backend keeps working regardless; RLS protects direct client/browser access.
