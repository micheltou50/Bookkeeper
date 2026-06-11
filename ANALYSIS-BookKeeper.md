# BookKeeper — Full Code Analysis

**Date:** 2026-06-11 · **Scope:** `GitHub\Bookkeeper` (Vite + React SPA in `src/App.jsx`, Netlify functions, Supabase migrations). Analysis only — no code was changed, nothing was run against live services.

**Codebase shape:** the entire frontend is one ~2,470-line file (`src/App.jsx`) containing one giant `BookkeeperApp` component with ~25 sub-components defined *inline inside its render scope*. Six Netlify functions handle PDF generation, Outlook OAuth/email, AI receipt extraction, and scheduled payment reminders. Supabase migrations 0001–0006 only patch a hand-built live schema — no migration creates the core tables.

Severity legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

---

## 1. BROKEN

### 🔴 1.1 No RLS policies on `bk_contacts`, `bk_transactions`, `bk_jobs` — while signup is open and all users share one business id
`supabase/migrations/0003_rls_policies.sql:41-44`, `src/App.jsx:207` (open `signUp`), `src/App.jsx:46-47` (single shared `business_id: "mworx"`), `src/App.jsx:447-452` (queries filter only by `business_id`, never `user_id`)
The RLS migration covers invoices, invoice items, and profiles only; the contacts/transactions/jobs policies are **commented out** ("uncomment if needed"). The frontend reads/writes those tables with the anon key filtered only by a constant business id every user shares, and the login screen lets anyone sign up. If the live DB matches the migrations, any new signup can read, modify, and delete every user's expenses (amounts, reimbursement data), contacts, and projects.
**Fix:** apply owner policies (`auth.uid() = user_id`) to all three tables, and/or disable public sign-up in Supabase Auth. **Verify the live DB first** — migrations are hand-applied (see 5.6), so production may differ in either direction.

### 🟠 1.2 Quotes get auto-marked "overdue" by the invoice overdue sweep — then vanish from the quote tabs
`src/App.jsx:477-481`
The sweep on every load updates **all** `bk_invoices` rows with `status="sent"` past `due_date` to `"overdue"` — but quotes live in the same table with the same `"sent"` status, and their `due_date` is the 30-day "valid until" date. Thirty days after sending, every quote becomes `"overdue"`, a status not in the quote filter tabs (`App.jsx:1872`: `all/draft/sent/accepted/declined`), so it disappears from every tab except "All".
**Fix:** add `.eq("type", "invoice")` to the update.

### 🟠 1.3 Unlinking a project from an existing invoice always fails (empty string sent to a uuid column)
`src/App.jsx:1368` (form sets `project_id: e.target.value || ""`) + `src/App.jsx:636-645` (`updateInvoice` null-coalesces only `date`/`due_date`/`paid_date`)
`addInvoice` normalizes `project_id || null`, but `updateInvoice` passes the value through verbatim. Choosing "No project" on an existing invoice sends `project_id: ""` to a uuid column (`0004_projects.sql:16`), Postgres rejects it, and the user gets "Failed to save invoice: invalid input syntax for type uuid".
**Fix:** in `updateInvoice`, add `if ("project_id" in dbUpdates) dbUpdates.project_id = dbUpdates.project_id || null;`

### 🟠 1.4 Inline component definitions: any parent re-render remounts open forms and wipes unsaved edits
`src/App.jsx:394-396` (acknowledging comment), components defined at 999, 1169, 1279, etc.
All forms (`InvoiceForm`, `ExpenseForm`, `ContactForm`, …) are defined *inside* `BookkeeperApp`, so their function identity changes on every parent render and React unmounts/remounts them, resetting local state. Concretely: with an invoice form open and unsaved edits, clicking "Download PDF" (`setPdfLoading`) or a background `loadData` finishing remounts the form and silently discards the user's typing. The `formDirtyRef` workaround comment confirms this is live, known behavior. Page-level search/filter state resets the same way.
**Fix:** hoist all sub-components to module scope and pass props. This is the single highest-payoff structural fix.

### 🟠 1.5 `local-test-reminders.mjs` is completely broken — `supabase` is null when `runReminders` is imported directly
`local-test-reminders.mjs:41-42`, `netlify/functions/send-reminders.mjs:23, 27-42, 468`
The harness imports `runReminders` and calls it directly, but after the refactor to request-time env resolution, the module-scoped `supabase` client is only assigned inside `resolveRuntime()`, which only the default HTTP handler calls (line 468). The harness throws `TypeError: Cannot read properties of null (reading 'from')` immediately. Its own comment (lines 20-21, "builds its Supabase client at import time") describes the old, pre-refactor design.
**Fix:** export `resolveRuntime()` and call it at the top of `runReminders`, or have the harness invoke the default export with a synthetic `Request`.

### 🟠 1.6 `send-reminders` is both a scheduled function and an HTTP endpoint the frontend POSTs to
`netlify/functions/send-reminders.mjs:538-540` (`schedule: "@daily"`), called from `src/App.jsx:905` (Send Reminder button) and `App.jsx:1588` (preview/send-now panel)
Per Netlify's docs, scheduled functions are **not reachable via their public URL** on production deploys. If that holds here, the Send Reminder button and the reminders preview panel 404 in production and all the manual-auth handling (lines 470-530) is unreachable. If the URL *is* reachable, then the unauthenticated cron path is exposed (see 4.1). Either way the dual-mode design is unsound.
**Fix:** split into `send-reminders-cron` (scheduled, no HTTP) and an authenticated HTTP function, both calling shared logic from a lib module (also fixes 1.5 cleanly).

### 🟡 1.7 `send-invoice-outlook` has no top-level try/catch — a hung Microsoft call crashes the handler
`netlify/functions/send-invoice-outlook.mjs:14-15, 29, 142, 226, 248`
`fetchWithTimeout` aborts after 12 s by throwing `AbortError`; none of its call sites (`refreshAccessToken`, both `doGraph` calls) are inside a try/catch. The file's own comment describes the resulting "empty lambda response" failure mode — the protection was never added (send-reminders has exactly this wrapper at line 466).
**Fix:** wrap the handler body in try/catch returning a JSON 500.

### 🟡 1.8 Document numbering generates duplicate `…001` numbers until a profile row exists
`src/App.jsx:83` (filter on `profile?.business_id`) + `App.jsx:472` (fallback profile has no `business_id`)
If `bk_profiles` has no row yet, the fallback profile object lacks `business_id`, so `getNextDocumentNumber` matches zero invoices and every new document gets sequence 001 until Settings is saved once.
**Fix:** filter by the `biz` state instead of `profile.business_id`.

### 🟡 1.9 Local test harness validates the wrong env vars for `--send`
`local-test-reminders.mjs:25-29, 38`
For `--send` it requires `MICROSOFT_CLIENT_ID/SECRET` + `TOKEN_ENCRYPTION_KEY` and prints "real emails WILL go out via Outlook", but `runReminders` sends exclusively via Resend (`send-reminders.mjs:102, 350`). It never checks `RESEND_API_KEY`, so a send run without it would log a `failed` row for every overdue invoice instead of refusing to start.
**Fix:** require `RESEND_API_KEY` for `--send`; drop the Microsoft checks; update the comments.

### ⚪ 1.10 Switching document type keeps an invalid status
`src/App.jsx:1291-1298, 1342` — flipping a "paid" invoice to a quote (or "accepted" quote to invoice) keeps a status not in the target type's tab set, so the document disappears from all status filters except "All". **Fix:** reset status to `"draft"` (or map it) in `updateType`.

### ⚪ 1.11 Mobile tab bar icons never show the active color
`src/App.jsx:2121` vs `175-193` — all `Icons.*` are zero-prop arrow functions, so the `style` prop passed in `MobileTabBar` is silently discarded. **Fix:** accept/spread props in the icon components.

### ⚪ 1.12 Null dates render as "01 Jan 1970"
`src/App.jsx:51` (`fmtDate`), unguarded at 1903 and 2284 — `addInvoice` allows `date: null`, and `new Date(null)` is the Unix epoch. **Fix:** `fmtDate = (d) => d ? … : ""`.

---

## 2. DEAD ENDS

### 🟡 2.1 `html2pdf.js` imported but never used — hundreds of KB of dead bundle weight
`src/App.jsx:3` — the only occurrence is the import; PDF generation goes through the Netlify function with an iframe-print fallback (lines 770, 797-806). html2pdf drags in html2canvas + jsPDF. **Fix:** delete the import and the dependency.

### 🟡 2.2 The "send" branch of `send-invoice-outlook` is unreachable — `sent_at` is never populated by anything
`netlify/functions/send-invoice-outlook.mjs:247-271`, only caller `src/App.jsx:872` sends `draft: true`
The actual `sendMail` path — including the only code in the whole system that sets `status: "sent"` / `sent_at` (lines 266-269) — never runs (the frontend deliberately doesn't auto-mark sent, `App.jsx:845`). **Fix:** delete the branch or add a UI path that uses it.

### 🟡 2.3 `RESEND_API_KEY` / `REMINDER_FROM_EMAIL` read by code but missing from `.env.example`
`netlify/functions/send-reminders.mjs:15-16` vs `.env.example`
The entire reminder feature depends on Resend, yet the env template documents Microsoft/Anthropic/Supabase keys only. A fresh setup gets a cron that writes `failed` log rows for every overdue invoice. Also stale: `.env.example:8-9` claims functions hard-code a fallback — `send-reminders.mjs:3-5` explicitly removed all fallbacks. `VITE_SUPABASE_URL` (read in `src/supabaseClient.js:3`) is missing from the example too. **Fix:** add the three variables; fix the stale comment.

### ⚪ 2.4 Business switcher is dead code
`src/App.jsx:502-505` (`switchBiz` never called), `976-977` (unused `s.bizSwitcher`/`s.bizBtn` styles), `46-48` (`BUSINESSES` has one entry). **Fix:** remove, or restore the UI.

### ⚪ 2.5 `sidebarOpen` state, `s.sidebarMobile` style, `Icons.Menu` never used
`src/App.jsx:398, 974, 188, 2396` — `sidebarOpen` is written but never read; leftovers from a replaced mobile-drawer design. **Fix:** delete all three.

### ⚪ 2.6 `accepted_quote_id` write path unreachable; DB column never populated
`src/App.jsx:705` — no caller passes `accepted_quote_id`; `acceptQuote` (714-728) links via `bk_invoices.project_id` instead, so the column added in `0004_projects.sql:12` stays null forever. **Fix:** remove the branch; consider dropping the column.

### ⚪ 2.7 Revenue accounts and "income" transactions are unreachable
`src/App.jsx:6-8, 1177, 1180` — `DEFAULT_ACCOUNTS` defines three Revenue accounts but every form hardcodes `type: "expense"` and filters to Expense accounts. **Fix:** remove them or build income entry.

### ⚪ 2.8 Misc dead ends
- `pa.contract_value` quick-add field has no input and is never sent (`App.jsx:1307, 1382`).
- `toName` parameter of `sendViaResend` destructured but unused (`send-reminders.mjs:102`).
- Stale UI copy: settings claim reminders send "from your connected Outlook" (`App.jsx:1700`) — they send via Resend only.

---

## 3. SILENT FAILURES

### 🔴 3.1 Systemic: ~17 awaited Supabase mutations never check `.error`, and modals close as if the save succeeded
`src/App.jsx:548, 572, 580, 588, 594, 602, 610, 619, 623, 662, 677, 682, 692, 706, 723, 741, 926, 950`
supabase-js returns `{ data, error }` and **never throws** on query errors. In `addTransaction` (548), `updateTransaction` (572), `addContact` (594), `addInvoice` (619), `saveProfile` (741), etc., a failed insert/update (RLS denial, constraint violation, network) silently yields `data: null`; the `if (inserted)` guard skips the state update but execution continues to `setModal(null)` — the user's expense/invoice/contact/settings are **discarded with zero feedback**. Only `updateInvoice`'s header update (644-645) checks the error. This is the single biggest reliability hole in the app.
**Fix:** a small data-layer helper that checks `error`, surfaces a toast, and keeps the modal open on failure — one fix point instead of 17 patches.

### 🟠 3.2 Invoice line-item save is delete-then-insert with no error checks — items can be permanently lost
`src/App.jsx:646-650`
`updateInvoice` deletes all `bk_invoice_items` then inserts replacements; neither result is checked and there's no transaction. If the delete succeeds and the insert fails, the invoice's items are gone from the DB and the UI shows `items: []` — destructive, unrecoverable, silent.
**Fix:** check both errors; ideally swap items inside a Postgres RPC/transaction.

### 🟠 3.3 Deletes optimistically remove rows from the UI even when the DB delete failed
`src/App.jsx:578-584` (transaction), `608-614` (contact), `660-666` (invoice), `730-737` (project)
All four delete handlers ignore the result and unconditionally filter local state; a failed delete makes the row disappear until the next reload "resurrects" it. **Fix:** check `error` before mutating local state.

### 🟠 3.4 `generate-invoice-pdf`: items query error ignored — a $0.00 PDF can be generated and emailed
`netlify/functions/generate-invoice-pdf.mjs:309-313` (error discarded), subtotal over `items || []`
On a transient DB failure, an itemised invoice renders with zero line items and a $0.00 total — a legally wrong document, uploaded and potentially drafted to a client with no error anywhere. **Fix:** return 500 on query error; fail if an itemised invoice has zero items.

### 🟠 3.5 `bk_email_connections`: RLS enabled with no policy, but the frontend reads/deletes it directly
`supabase/migrations/0002…sql:16` (enable RLS, no policy anywhere) vs `src/App.jsx:452` (select) and `App.jsx:949-951` (delete)
RLS-enabled-with-no-policy returns zero rows to the anon-key client: the Outlook "connected" status would never display and `disconnectOutlook` would silently delete nothing (leaving encrypted Graph tokens in the DB). Either the live DB has an undocumented policy (schema drift) or the feature is broken — both are findings. Also, `select("*")` would pull token ciphertext to the browser if a broad policy is added.
**Fix:** add an owner policy scoped to non-secret columns; verify live state.

### 🟡 3.6 `send-reminders`: profiles query error ignored — reminders go out branded "Our company" with no bank details
`netlify/functions/send-reminders.mjs:317-323, 334` — on failure `profileMap` is empty and emails still send, signed "Our company" with no payment block, to real clients, with nothing logged. It also fetches *all* users' profiles even on user-scoped manual runs. **Fix:** abort on error; scope by `user_id` for manual runs.

### 🟡 3.7 `send-reminders`: a successful send whose log-status update fails will be re-sent (double email)
`send-reminders.mjs:273-277, 287-289, 387-389` — after Resend succeeds, `setLogStatus(claimId, "sent")` ignores its error; the row stays `"sending"`, goes stale after 30 min, is classified retryable, and the next daily run emails the client again. (The claim mechanism itself — insert/CAS on unique `(invoice_id, threshold)` — is well designed; this is the unguarded link.) Same pattern in `writeLog` (233-245). **Fix:** check and retry the post-send status write; log loudly.

### 🟡 3.8 Receipt pipeline failures are swallowed at three points
- Upload result ignored in `doScan` (`src/App.jsx:1091`): a failed storage upload still produces `receiptPath`, saving an expense pointing at a nonexistent file ("Could not load receipt" later).
- Post-rename DB update unchecked (`App.jsx:554-557`): file moved, row keeps the old path → receipt unopenable.
- Image-load promise never resolves on decode error (`App.jsx:1043`, only `onload` hooked) → modal stuck on "Scanning receipt…" forever.
**Fix:** check the upload error before extraction; check the rename update; hook `img.onerror`.

### 🟡 3.9 `loadData` failures render an empty app with console-only logging
`src/App.jsx:446-453, 491-492` — each of the six parallel queries uses `xRes.data || []` without checking `.error`; any RLS/network failure looks like "you have no data" — alarming in a bookkeeping app. **Fix:** check each result; show an error banner with retry.

### ⚪ 3.10 Minor swallowed results
- `generate-invoice-pdf`: `pdf_path` update + `createSignedUrl` errors ignored (`generate-invoice-pdf.mjs:362-370`) → later "PDF has not been generated yet" confusion.
- `send-invoice-outlook`: refreshed-token persist update unchecked (`send-invoice-outlook.mjs:49-54`).
- `outlook-oauth-callback`: nonce delete result ignored (`outlook-oauth-callback.mjs:39`) — weakens single-use guarantee.
- Clipboard "Copied!" alert fires even when the copy rejected (`App.jsx:2042-2043, 2141`).
- Fire-and-forget `upsertJob(...)` in `saveInv` (`App.jsx:1318`) and unawaited `updateInvoice(inv.id, {status:"overdue"})` in `sendReminder` (`App.jsx:894, 913`) — the latter also closes the open edit modal as a surprise side effect (because `updateInvoice` ends with `setModal(null)`).
- Logo upload error swallowed (`App.jsx:1619-1623`).

---

## 4. OTHER RISKS

### 🟠 4.1 Unauthenticated POST to `send-reminders` runs the global cron path for all users
`netlify/functions/send-reminders.mjs:482, 524` — `isManual = !!authToken || dryRun;` a request with no auth header and no `dryRun` falls through to the global batch send (`userId/businessId` null). There is no shared secret or scheduled-event check distinguishing the scheduler from a random POST. Damage is bounded by the idempotency log, but an attacker can force sends/retries and burn Resend quota. Severity depends on whether the scheduled function is HTTP-reachable (see 1.6). **Fix:** the 1.6 split removes the exposure; the HTTP function then requires a Bearer token unconditionally.

### 🟠 4.2 Invoice-number race / no DB uniqueness guarantee
`src/App.jsx:78-88`, no unique constraint in any migration — the next number is computed client-side from loaded rows; two tabs/devices (or creating before a reload finishes) produce duplicate invoice numbers, an accounting/compliance problem. Compounded by 1.8. **Fix:** unique index on `(user_id, business_id, type, number)` + conflict handling, or allocate via an RPC.

### 🟠 4.3 No storage bucket policies anywhere in the repo — receipt/invoice access control is convention-only
No `storage.objects` policy in any migration; uploads at `src/App.jsx:1090-1091, 1618-1619` rely on `${user.id}/…` path prefixes; `App.jsx:1621` uses `getPublicUrl` for logos in the same `receipts` bucket as private financial documents. **Fix:** add a migration documenting owner-scoped storage policies; move logos to a dedicated public bucket.

### 🟡 4.4 OAuth account-linking CSRF: state is bound to the initiator, not the completing browser
`netlify/functions/outlook-oauth-start.mjs:43-53`, `outlook-oauth-callback.mjs:29-45, 76-86` — the nonce is stored with the *initiator's* user_id and the unauthenticated callback trusts it. An attacker can start a flow under their account, hand the `authUrl` to a victim, and the victim's mailbox tokens get saved under the attacker's account — letting the attacker send mail as the victim. (Nonce hygiene is otherwise correct: 32-byte, 10-min expiry, deleted before use.) **Fix:** double-submit — set an HttpOnly cookie at start and compare in the callback; consider PKCE.

### 🟡 4.5 HTML injection into the print/PDF document — no escaping in the frontend templates
`src/App.jsx:246-250, 288, 338-343, 371, 375`, written via `document.write` into a same-origin iframe at 802 — item notes, contact name/address, invoice notes/terms are interpolated raw into HTML. Mostly self-XSS, but the AI receipt extractor's `vendor` field prefills `contact`, making the path externally influenceable. (The server-side email template *does* escape — `send-reminders.mjs:58`.) **Fix:** a small `esc()` helper on every interpolation.

### 🟡 4.6 `@sparticuz/chromium` + esbuild bundling may break PDF generation in production
`netlify.toml:1-3`, `generate-invoice-pdf.mjs:335` — esbuild does not ship chromium's binary payload; deployments typically need `external_node_modules = ["@sparticuz/chromium", "puppeteer-core"]` (and the default 10 s timeout is tight for a cold Chromium start). If PDFs work in production today, ignore; if they only worked in `netlify dev`, this is why. **Fix:** add the externals and verify on a deploy preview.

### 🟡 4.7 Floating-point money math throughout
`src/App.jsx:297, 1315, 135, 141` — totals are float `qty*rate` sums stored as-is; rollups subtract floats (`contract - paid`), so stored totals can drift (`1234.5600000000001`) and "Remaining" can read `-0.00`. (DB-side `numeric` is correct — the drift is introduced client-side.) **Fix:** round to 2 dp at computation boundaries or work in cents.

### 🟡 4.8 No double-click protection on row-level actions — `acceptQuote` can create two projects
`src/App.jsx:1915-1917` (Accept/Mark-Paid/Delete row buttons), `714-720` (check-then-create without guard), `1728` (Settings save) — forms have a `saving` flag but row actions don't; double-clicking Accept on a quote with no project races the check and can create duplicate projects. **Fix:** track an in-flight id and disable the button.

### 🟡 4.9 No security headers on the deployed site
`netlify.toml` (whole file) — no CSP, no `X-Frame-Options` (clickjacking on the auth screen), no `X-Content-Type-Options`, for a financial app. **Fix:** add a `[[headers]]` block.

### ⚪ 4.10 Minor risks
- Env diagnostic returned to any authenticated caller leaks env-var names and secret lengths (`send-reminders.mjs:433-459, 490-492`) — keep it in logs only.
- `generate-invoice-pdf` accepts the auth token in the JSON body instead of the Authorization header (`generate-invoice-pdf.mjs:273`; sent from `App.jsx:772-774`) and returns raw `err.message` to the client (line 380).
- One-year signed URLs to the private logo object embedded in every reminder email (`send-reminders.mjs:134`) — acceptable for a logo; inline base64 like generate-invoice-pdf if not.
- Deleting an expense orphans its receipt file in storage (`App.jsx:578-584` — no `storage.remove`).
- Whole-table fetch of six tables per load, plus a redundant full second invoice fetch even when the overdue sweep matched nothing (`App.jsx:446-453, 483`); degrades as data accumulates.
- Consultant rollups grouped by free-text `contact_name` (`App.jsx:157-161`) — renaming a contact splits totals; store `contact_id` on invoices.
- `src/supabaseClient.js:4` defaults the anon key to `''` — a missing build env produces the known blank-app failure with no diagnostic; throw at module load instead.
- Anonymous signups: see 1.1 — even with full RLS, the app concept is single-business (`mworx` hardcoded), so open signup has no legitimate use.

### Schema-integrity notes
- `accepted_quote_id` (0004:12) has no FK; `bk_jobs.status`, `pricing_mode`, `threshold`, `bk_reminder_log.status` have documented value sets but no CHECK constraints; `contract_value` has no `>= 0`. (Money as `numeric` is correct.)
- Migration 0002's "email uniqueness" index actually dedupes connections `(user_id, business_id, provider)`, not email addresses — misleading name, works in practice.
- `bk_reminder_log`'s comment says threshold ∈ {1,7,14,30} but manual sends write `0` (`send-reminders.mjs:421`) — works, undocumented.

### Verified non-issues (checked, OK)
- `dist/` and `.env.local` are properly gitignored; `.env.local` holds only publishable values.
- Token crypto (`lib/token-crypto.mjs`) is sound: AES-256-GCM, fresh random 12-byte IV, auth tag verified, key length validated.
- The reminder claim/idempotency mechanism (insert-or-CAS on unique `(invoice_id, threshold)`) is a correct race guard.
- All five frontend-called function endpoints exist with matching methods/body shapes; functions verify the Supabase JWT and check row ownership.
- Reminder email HTML escapes user input server-side.
- All declared dependencies are imported somewhere (except that `html2pdf.js`'s import itself is dead — see 2.1).

---

## 5. IMPROVEMENTS (prioritized)

1. **Split `App.jsx`** — hoist the ~25 inline components to module scope (fixes the remount/data-loss bug class outright), then split into `components/`, `pages/`, `lib/api.js`, `lib/format.js`. ~2,470 lines in one file with one component is the root cause of several bugs above.
2. **Centralize Supabase mutations in a tiny data layer** that always checks `{ error }`, returns success/failure, and drives a toast system — one fix for the ~17 unchecked calls, the optimistic deletes, and the modal-closes-on-failure pattern.
3. **Split `send-reminders` into cron + authenticated HTTP functions** sharing a lib module (fixes 1.5, 1.6, 4.1 together).
4. **Baseline the schema**: `supabase db dump` into `0000_init.sql` so migrations are replayable and the documented RLS/storage-policy state is authoritative (today eight tables exist only in the live project — `migrations/README.md:3-10`).
5. **Replace `alert()`/`confirm()`** (20+ call sites) with non-blocking toasts/dialogs.
6. **Add a DB unique index on invoice numbers** and fix the two numbering bugs (1.8, 4.2).
7. **Error/empty/retry states for `loadData`** instead of a silently empty app.
8. **Add `[[headers]]` security headers** and the missing `.env.example` entries.
9. **Small UX fixes**: project search should match the displayed address (`App.jsx:1937` vs `projectLabel`); `MobileContacts` blank rows for company-only contacts (`App.jsx:2324`); `<td style={{display:"flex"}}>` breaking row alignment (1853, 1908, 2002); revoke `URL.createObjectURL` blobs (1015); move the `s` styles object and `navItems` to module scope (959-997).
10. **Delete dead code**: `html2pdf.js`, `switchBiz`, `sidebarOpen`/`Icons.Menu`, `accepted_quote_id` plumbing, Revenue accounts, the unreachable Outlook send branch (or wire it up and start populating `sent_at`).

---

## Top 10 — what I'd fix first

1. **Verify and apply RLS on `bk_contacts`/`bk_transactions`/`bk_jobs` + close open signup** (1.1) — potential cross-user exposure of all financial data; one SQL file to fix.
2. **Check `{ error }` on every Supabase mutation via a shared helper** (3.1, 3.3) — today saves and deletes silently vanish; the app *will* lose user data on any transient failure.
3. **Make invoice line-item replace atomic and checked** (3.2) — the only finding that can destroy existing data unrecoverably.
4. **Add `.eq("type","invoice")` to the overdue sweep** (1.2) — one line; quotes currently corrupt themselves after 30 days.
5. **Null-coalesce `project_id` in `updateInvoice`** (1.3) — one line; unlinking a project is currently impossible.
6. **Split `send-reminders` into cron + HTTP functions** (1.6, 4.1, 1.5) — the manual reminder buttons may 404 in production, and the cron path is unauthenticated.
7. **Hoist inline components out of `BookkeeperApp`** (1.4) — stops open forms losing unsaved edits whenever anything else re-renders.
8. **Check the items query in `generate-invoice-pdf`** (3.4) — prevents sending clients a $0.00 invoice PDF.
9. **Guard the post-send log write in `send-reminders`** (3.7) — prevents double-emailing clients about overdue invoices.
10. **Unique constraint + profile-fallback fix for document numbers** (4.2, 1.8) — duplicate invoice numbers are an audit problem you can prevent with one index.

*Caveat: migrations are hand-applied to the live "BookKeeper" Supabase project (`supabase/migrations/README.md`), so DB-layer findings (1.1, 3.5, 4.3) describe the repo's documented state — verify against the live dashboard before and after fixing.*
