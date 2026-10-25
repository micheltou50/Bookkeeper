# BookKeeper — AI Handoff

**Date of last update:** 2026-10-25
**Based on:** `main` @ `e02c7f1` (2026-10-10)
**Updated by:** Claude (initial documentation audit)

## Latest known development status

- The app is in use for quotes, invoices, projects, contacts, Outlook sending, OneDrive filing and automatic payment reminders. Accounting moved to MYOB on 2026-08-30.
- Last change set (2026-10-10):
  - companies as editable records,
  - an encrypted Vault,
  - a courtesy reminder 3 days before the due date,
  - a per-company reminder reply-to address.
- `main` is clean. Every remote branch is merged. No PRs are open.
- There are no automated tests and no GitHub CI. Only the Codemagic iOS pipeline exists.

## Recently completed features

Newest first, from `git log origin/main`. PR numbers come from the merge commits.

- **2026-10-10**
  - **Reminder reply-to** (#27, `3ca816b`): `bk_profiles.reminder_reply_to` (migration 0026, applied live per the commit).
  - **Due-soon reminder** (#26, `6d39e72`): a courtesy note 3 days before the due date, logged under threshold `-3`. It is skipped if the invoice was sent less than 2 days ago.
  - **Companies as records** (#25, `e6dbf2f`): each company is a `bk_profiles` row with its own logo, ABN, bank details, mailbox, prefixes, colour and archive flag. Server functions resolve the company through `lib/company.mjs` (migration 0025, applied).
  - **Vault page** (#24, `aa56119`): zero-knowledge encrypted secrets store (migration 0024, applied).
- **2026-10-01: Card payments hidden** behind `CARD_PAYMENTS_VISIBLE = false` (`83502ac`). The Stripe code is kept. The pay link now shows a "pay by bank transfer" page when the invoice has no token.
- **2026-09-24 – 09-26** (#22, #23)
  - Removed the in-app Remind button, because the scheduled function is not reachable over HTTP in production (`1d0bc38`).
  - Added a **Cancelled** invoice status (`bf72f94`).
- **2026-09-14 – 09-15** (#21)
  - Every document files into `<project>/01 - Admin/<Quotes|Invoices>` from its first save (`77fff7b`).
  - PDF pagination now uses a Chromium footer showing "Page n of N".
  - The preview shows the real PDF (`4856e69`).
  - Page breaks are written into the document.
  - Edit-in-preview, and Save & preview.
  - "Invoice a stage of the accepted quote" dropdown (`462952f`, migration 0023).
- **2026-09-11 – 09-13** (#20)
  - Quote types per application type, plus a project-first New Quote step (`3cc4397`, migration 0021, seed in `supabase/seeds/quote_types.json`).
  - Revised 20-clause quote terms.
  - "GST not applicable" flag (`64100c2`, migration 0022).
- **2026-09-01 – 09-05** (#16–#19)
  - Quote follow-up on the dashboard.
  - Payment plan (migration 0019).
  - Overdue now has one definition everywhere, and the project drawer stays within its company (`3ccdefa`).
  - Accepting a quote raises the stage-1 invoice from the payment plan.
  - Email and Save to OneDrive buttons in the preview header.
  - Reworked invoice footer.
  - Quote revision dropped from the UI (`8fa989c`).
- **2026-08-30 – 08-31** (#6–#15)
  - OneDrive project folders are created by copying `00000 - Master Folder` (`09484fa`).
  - Fixed forms losing data on remount: `ContactForm` and `BusinessSettings` hoisted, draft refs added (`19500d8`, `8938c0d`, `2217cc7`, `3b557a9`).
  - **Bookkeeping removed**: expenses, receipts, bank import/reconciliation, P&L and AI receipt extraction (`34de1ff`).
  - Global financial-year filter.
  - Invoices and Quotes moved directly into the sidebar.
  - Superseded quote status, with status changes from the list.
  - Readable status badges.
  - One primary row action plus an overflow menu.
  - Scope library (migration 0018).
  - Duplicate a quote.
  - Refuse to issue or accept an empty document.
- **2026-08-27: MYOB "Milestone 0"** (`f49b661`, `eab592a`; migration 0016)
  - Documents link to contacts through `contact_id`.
  - Document numbers are unique per company and type.
  - A trigger blocks deleting a document once it is synced to MYOB.
- **2026-07-07 – 07-18**
  - Sign-in-only auth, plus password reset and password change (`cee0420`).
  - Stripe card payments, and a BCC copy of every reminder (`3584b98`, migration 0014).
  - Project, quote and invoice workflow overhaul: job parties and quote templates (migration 0015).
  - In-app compose window.
  - Two-stage OneDrive filing (later simplified in `77fff7b`).
  - Card surcharge grossed up so the customer covers the full fee (`fe91163`).
- **2026-06-19 – 06-24**
  - Capacitor iOS app and Codemagic pipeline that uploads to App Store Connect for internal testers.
  - Divisions: Mworx Group and MT Management (migrations 0007, 0008).
  - OneDrive saving, job numbers.
  - Expense, bank and receipt features (since removed).
- **2026-05-14 – 06-14**
  - Initial build.
  - Moved from a single JSON blob (`bk_app_data`) to proper tables (`ef9e677`).
  - Puppeteer PDFs.
  - Outlook OAuth with encrypted tokens.
  - Reminder idempotency log (migration 0001).
  - Reminders switched to Resend only (`69b9aa9`).
  - Projects and quotes, lump-sum pricing.
  - Audit fixes after `ANALYSIS-BookKeeper.md` (`af2b83a`).

## Current work in progress

- **No open PRs** (GitHub API, 2026-10-25).
- **No unmerged branches.** All 25 remote branches have 0 commits that are not on `origin/main`, so they are leftovers that could be deleted:
  - `claude/invoice-reminder-send-issue-pjbmzn`
  - `cursor/audit-fixes-b8a8`, `cursor/divisions-reimbursement-b8a8`, `cursor/onedrive-receipts-folder-b8a8`
  - `feat/accept-uses-payment-plan-stage-1`, `feat/companies`, `feat/due-soon-reminder`, `feat/flat-sales-nav`, `feat/list-status-legibility`, `feat/payment-plan`, `feat/project-drawer-fixes`, `feat/project-folder-from-master`, `feat/project-quote-invoice-flow`, `feat/quote-followup`, `feat/quote-programme`, `feat/quote-superseded-status`, `feat/quote-types`, `feat/reminder-reply-to`, `feat/row-actions-mobile-cards`, `feat/vault`
  - `fix/division-leak-and-overdue`, `fix/form-remount-data-loss`, `fix/needs-attention-left-to-invoice`, `fix/pdf-pages-and-project-filing`
  - `refactor/remove-bookkeeping`

  Their last commits range from 2026-06-20 (`cursor/*`) to 2026-10-10.

## Outstanding bugs

Status of the `ANALYSIS-BookKeeper.md` (2026-06-11) findings, re-checked against `e02c7f1`, plus new findings from this audit.

**Still open**
- **`local-test-reminders.mjs` is broken.**
  - It imports `runReminders` directly, but the module's `supabase` client is only created inside `resolveRuntime()`, which only the HTTP handler calls (`netlify/functions/send-reminders.mjs`). Result: a null client.
  - `--send` still checks the Microsoft env vars instead of `RESEND_API_KEY`, and its comments still say "via Outlook" (ANALYSIS 1.5, 1.9).
- **`send-reminders` is both a scheduled job and an HTTP endpoint.** A request with no Bearer token and no `dryRun` runs the global cron path for all users (`isManual = !!authToken || dryRun`). This only matters if the URL is reachable, which is **Unverified**; commit `1d0bc38` says it is not (ANALYSIS 1.6, 4.1).
- **`send-reminders` profile load ignores errors.** On failure, reminders go out branded "Our company" with no bank details. It also loads every user's profiles (ANALYSIS 3.6).
- **`send-reminders`: `setLogStatus` / `writeLog` errors are unchecked.** A successful send whose log update fails can be sent again after 30 minutes (ANALYSIS 3.7).
- **`send-reminders` env diagnostic.** It returns env var names and value lengths to any authenticated caller (ANALYSIS 4.10).
- **`send-invoice-outlook` has no top-level try/catch.** A Graph timeout (`AbortError` after 12 s) produces an empty function response (ANALYSIS 1.7).
- **`send-invoice-outlook` reports the wrong recipient.** The response says `sent_to: inv.contact_email` even when the compose window changed the recipient (`to_override`). The UI shows the override, so this is cosmetic.
- **`generate-invoice-pdf` checks almost nothing.**
  - The items query error is ignored, so an itemised invoice could render as $0.00 (ANALYSIS 3.4).
  - The `pdf_path` update and the signed-URL error are also unchecked.
  - The auth token travels in the JSON body.
  - Raw `err.message` is returned to the client.
- **`bk_email_connections` has no RLS policy in any repo migration.** RLS is enabled (0002), and the browser selects (`select("*")`, which includes the encrypted token columns) and deletes rows directly. The live policy is **Unverified** (ANALYSIS 3.5).
- **No Storage bucket policies in the repo.** Logos are stored with `getPublicUrl` in the same `receipts` bucket as legacy receipts (ANALYSIS 4.3).
- **OAuth state is bound to the initiating user, not the completing browser.** This leaves a CSRF/account-linking risk in `outlook-oauth-start.mjs` / `outlook-oauth-callback.mjs`. The nonce delete result is also unchecked (ANALYSIS 4.4).
- **No security headers in `netlify.toml`** (ANALYSIS 4.9).
- **Chromium bundling.** There is no `external_node_modules` or timeout config for `@sparticuz/chromium`. Whether PDFs work reliably in production is **Unverified** (ANALYSIS 4.6).
- **Remaining unchecked writes.** `upsertJob` and the job-party insert inside `createProject` (`src/App.jsx`) do not check `{error}`.
- **Floating-point money maths on the client** (ANALYSIS 4.7).
- **Schema drift.**
  - The core tables `bk_invoices`, `bk_invoice_items`, `bk_contacts`, `bk_jobs`, `bk_profiles`, `bk_email_connections` and `bk_oauth_states` have no `CREATE TABLE` in the repo.
  - Several columns used by code have no migration: `sent_at`, `pdf_path`, `pdf_generated_at`, `converted_from_quote_id`, `last_used_at`, and the profile logo, bank and template columns.
  - The `(user_id, business_id)` unique constraint that the `bk_profiles` upsert depends on is not defined in the repo.
  - The live tables `bk_receipts` and `bk_myob_connections` have no trace in the repo.
- **Stale docs.**
  - `supabase/migrations/README.md` stops at 0010, says "Urgent: apply 0007–0010", and references the deleted `scripts/apply-supabase-migrations.mjs`.
  - `README.md` is the Vite template.
  - `ANALYSIS-BookKeeper.md` describes a pre-August codebase (2,470 lines, expenses).
  - `.env.example` is missing `VITE_SUPABASE_URL` and `STRIPE_SURCHARGE_FIXED`, and still says functions hard-code a Supabase URL fallback (they do not).
- **Duplicate migration prefixes.** `0003`, `0004` and `0005` are each used twice, and there is no `0017`. This makes the order ambiguous if the migrations are ever replayed.

**Fixed since the analysis** (verified in code)
- RLS for contacts, transactions and jobs is written into `0003` (1.1).
- The overdue sweep is limited to `type='invoice'` (1.2).
- `project_id` is coalesced to null (1.3).
- Document numbering is keyed on company (1.8).
- `fmtDate` handles null dates (1.12).
- `html2pdf.js` was removed (2.1).
- `RESEND_*` is documented in `.env.example` (2.3, partly).
- The `sbWrite` error helper is used for nearly all mutations (3.1, 3.3).
- Line items are inserted before old ones are deleted (3.2).
- Invoice numbers have a DB unique index (4.2).
- The document HTML is escaped (4.5).
- Open sign-up was removed from the UI (4.10).
- The inline-component data loss (1.4) is mitigated by draft refs and partial hoisting, but not eliminated.

**Security note:** no secrets were found in the working tree. Git history (`62fe21e`, removed in `4820070`) contains a hard-coded Supabase **anon** (public) key. It is not a secret, so no rotation is needed, but avoid hard-coding keys again.

## Planned changes

From repo evidence only:
- **MYOB integration.** Migration `0016` is "Milestone 0". The `myob_sync_status` / `myob_synced_at` / `myob_sync_error` columns and the delete trigger are in place, but nothing writes them yet. A live `bk_myob_connections` table exists, with no code.
- **Card payments** may come back by setting `CARD_PAYMENTS_VISIBLE = true` (`src/lib/card-payments.mjs`).
- **Quote terms clause 16** (liability) is flagged for legal review (`src/App.jsx`, comment above `DEFAULT_QUOTE_TERMS`).

## Important decisions made

- Accounting is out of scope. MYOB owns it. The legacy data and tables were kept (`34de1ff`).
- Automatic reminders go out through Resend from a no-reply sender with a reply-to address. Document emails go out through the company's own Outlook account (Graph).
- Manual reminder sending was removed or hidden. Only the daily automatic run remains (`1d0bc38`, `SHOW_MANUAL_REMINDER_CONTROLS = false`).
- Card payments are hidden, not deleted (`83502ac`).
- Each document uses its own company's letterhead and mailbox, regardless of the company the app is switched to (`e6dbf2f`).
- Every quote and invoice files into its project folder from the first save. Project folders are copies of the OneDrive master folder (`77fff7b`, `09484fa`).
- The Vault is zero-knowledge with a separate passphrase. A lost passphrase cannot be recovered (`aa56119`).
- Status vocabulary is defined in the UI only (`DOC_STATUS`). The database has no CHECK constraint (`2132c9a`).
- Migrations are applied by hand and must be idempotent ("safe to re-run" in every file).

## Pending tests

- **No automated test suite exists.** Available checks:
  - `npm run lint` (ESLint)
  - `npm run build` (Vite)
- `local-test-reminders.mjs` is meant for a reminder dry-run (`node --env-file=.env local-test-reminders.mjs`), but it is broken (see above) and talks to the live database.
- **Needs manual verification**
  - Production PDF generation (cold start, page count, footer) on `bkeeper.netlify.app`. **Unverified.**
  - That the daily reminder run is firing. Check the function logs and `bk_reminder_log`, including the new `-3` courtesy threshold and the reply-to/BCC headers.
  - Company switching end to end: an MT Management document must carry MT's logo, bank details and mailbox from the "All companies" view.
  - Outlook connect, send and token refresh for each company. OneDrive master-folder copy for a new project, including the `pending` path.
  - Vault: create, unlock, wrong passphrase, change passphrase, auto-lock, delete.
  - The Codemagic iOS build after each push to `main`, and native `API_BASE` calls.
  - The live database against the repo migrations, the RLS policies (especially `bk_email_connections`) and the storage bucket policies.

## Recommended next development tasks

1. **Baseline the schema.** Dump the live `BookKeeper` schema (tables, constraints, RLS, storage policies, triggers) into a baseline migration so the repo can rebuild the database. Document `bk_receipts` and `bk_myob_connections`. Rewrite `supabase/migrations/README.md`.
2. **Lock down `bk_email_connections`.** Confirm the live policy. Add an owner policy limited to non-secret columns, or move the read and disconnect into a function so token ciphertext never reaches the browser.
3. **Split `send-reminders`** into a scheduled function and an authenticated HTTP function that share one library. Do in the same change:
   - check the profile-load and log-status errors,
   - drop the env diagnostic from responses,
   - fix `local-test-reminders.mjs` to use Resend and the shared library.
4. **Harden `generate-invoice-pdf` and `send-invoice-outlook`.**
   - Return 500 when the items query fails.
   - Refuse to render an itemised invoice with no items.
   - Wrap the Outlook handler in a top-level try/catch.
   - Move the token to the Authorization header.
5. **Netlify config.** Add security headers. Confirm the Chromium bundling (`external_node_modules`) and the function timeout on a deploy preview.
6. **OAuth state hardening.** Bind the state to the browser (HttpOnly cookie or PKCE) and check that the nonce delete succeeded.
7. **Hygiene.**
   - Replace the boilerplate `README.md`.
   - Add the missing `.env.example` entries and fix its stale comment.
   - Mark `ANALYSIS-BookKeeper.md` as historical.
   - Delete the 25 merged remote branches.
8. **Continue hoisting inline components** out of `BookkeeperApp`, starting with `InvoiceForm` and `ProjectForm`, so the draft-ref workarounds can go.
9. **MYOB sync (Milestone 1).** Only after tasks 1–2: decide what writes `myob_sync_status` and how `bk_myob_connections` is used.

## Update log
- 2026-10-25 — Initial AI_CONTEXT/AI_HANDOFF created from codebase audit.
