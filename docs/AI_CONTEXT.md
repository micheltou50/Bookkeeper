# BookKeeper — AI Context

> Shared context for AI assistants (Claude, ChatGPT/Codex). Describes what is true in the code at the commit below. Anything not confirmed in the code is marked **Unverified**.

| | |
|---|---|
| Repository | micheltou50/Bookkeeper (public) |
| Default branch | main |
| Verified against | `e02c7f1` (2026-10-10) |
| Last reviewed | 2026-10-25 |
| Related repos | None referenced in code |

## 1. Purpose

BookKeeper is a private, sign-in-only web app (plus an iOS wrapper) that the owner's businesses use to run **quotes, invoices, projects and clients**. It produces branded A4 PDFs, emails them from the company's Outlook mailbox, files them into OneDrive project folders, and sends automatic payment reminders.

It is multi-company: the two built-in companies are **Mworx Group** (drafting and NSW planning; slug `mworx`) and **MT Management** (STR property management; slug `mt_management`). More can be added in Settings. The quote side is shaped around NSW planning work (application types DA, CC, CDC, S4.55, Drafting Only, ready-written scope "quote types", staged payment plans).

Despite the name, it no longer does bookkeeping. Commit `34de1ff` (2026-08-30) removed expenses, receipts, bank import/reconciliation, P&L and AI receipt extraction: "MYOB owns accounting now". The tables those features used are still in the database (§6).

A separate **Vault** page is a zero-knowledge encrypted store for business secrets (government logins, bank portals and so on) (§5.10).

## 2. Technology stack

| Layer | What | Evidence |
|---|---|---|
| Frontend | React 19 SPA, Vite 8, plain JS/JSX (no TypeScript in `src/`), inline style objects, DM Sans via Google Fonts | `package.json`, `vite.config.js`, `index.html` |
| Backend | Supabase (Postgres, Auth, Storage) through `@supabase/supabase-js` v2. The browser uses the anon key with RLS; functions use the service-role key | `src/supabaseClient.js`, `netlify/functions/*` |
| Server functions | Netlify Functions (ESM `.mjs`, modern `(req) => Response` signature, bundled by esbuild) | `netlify.toml`, `netlify/functions/` |
| PDF | `puppeteer-core` + `@sparticuz/chromium` running headless Chromium inside a function | `netlify/functions/generate-invoice-pdf.mjs` |
| Email (documents) | Microsoft Graph (Outlook) via OAuth 2.0, with tokens stored AES-256-GCM encrypted | `outlook-oauth-*.mjs`, `send-invoice-outlook.mjs`, `lib/token-crypto.mjs` |
| Email (reminders) | Resend REST API | `send-reminders.mjs` |
| Files | Microsoft Graph OneDrive (`Files.ReadWrite`) | `onedrive-upload.mjs` |
| Card payments | Stripe Checkout (REST, no SDK) + signed webhook. **Currently hidden** | `pay-invoice.mjs`, `stripe-webhook.mjs`, `src/lib/card-payments.mjs` |
| Crypto (Vault) | Web Crypto: PBKDF2-SHA256 + AES-256-GCM, no dependencies | `src/lib/vault-crypto.mjs` |
| Mobile | Capacitor 8 iOS (`com.mtmanagement.bookkeeper`), built by Codemagic | `capacitor.config.ts`, `ios/`, `codemagic.yaml` |
| Lint | ESLint 10 flat config with react-hooks/react-refresh. Three React Compiler-tier rules are turned off on purpose | `eslint.config.js` |
| Tests | None | — |

## 3. System architecture

```
 Browser / iOS WebView (React SPA, src/App.jsx)
   │  supabase-js (anon key + user JWT, RLS)          ┌──────────────────────────┐
   ├──────────────────────────────────────────────────▶ Supabase "BookKeeper"     │
   │                                                   │ Postgres bk_* tables      │
   │  fetch /.netlify/functions/* (Bearer JWT)          │ Storage: receipts, invoices│
   ▼                                                   └──────────▲───────────────┘
 Netlify Functions (service-role key) ────────────────────────────┘
   generate-invoice-pdf ── Chromium → Storage "invoices"
   send-invoice-outlook ── Microsoft Graph sendMail (PDF attached)
   onedrive-upload ─────── Microsoft Graph drive (folders, uploads)
   outlook-oauth-start / outlook-oauth-callback ── login.microsoftonline.com
   send-reminders (schedule @daily) ── Resend API
   pay-invoice (public) ── Stripe Checkout   ◀── customer pay link
   stripe-webhook (public) ◀── Stripe checkout.session.completed
```

- On native iOS, `API_BASE` is hard-coded to `https://bkeeper.netlify.app` so the WebView can reach the functions (`src/App.jsx:8`). On the web, calls are relative.
- Functions authenticate the caller by passing the user's JWT to `auth.getUser()` on an anon-key client. They then use a service-role client and check `user_id` ownership themselves.
- `src/lib/doc-html.mjs` and `src/lib/card-payments.mjs` are imported by **both** the browser bundle and the functions, so the in-app preview and the server PDF share one layout.

## 4. Repository layout

| Path | Role |
|---|---|
| `src/App.jsx` | Almost the whole frontend (~5,500 lines). Module-scope helpers and components: login/reset, `DocViewer`, `ComposeEmail`, `BusinessSettings`, `ContactForm` and the Vault components. The main `BookkeeperApp` component holds all state, the data loading, every mutation, and inline page/form components (`InvoiceForm`, `QuoteStart`, `ProjectForm`, `DashboardPage`, `DocList`, `ProjectsPage`, `ContactsPage` and their mobile twins) |
| `src/lib/doc-html.mjs` | `buildDocHTML()` is the single quote/invoice layout, with modes `pdf` / `screen` / `edit`. Also page-break parsing and scope text ⇄ items conversion. HTML-escapes all user fields |
| `src/lib/vault-crypto.mjs` | Vault key derivation, wrap/unwrap, item encrypt/decrypt, passphrase strength meter and password generator |
| `src/lib/card-payments.mjs` | `CARD_PAYMENTS_VISIBLE` master switch (currently `false`) |
| `src/supabaseClient.js` | Supabase client. The URL falls back to the project URL; the anon key comes from `VITE_SUPABASE_ANON_KEY` |
| `netlify/functions/*.mjs` | Eight functions (§7) |
| `netlify/functions/lib/` | `company.mjs` (resolves a document's company profile and mailbox), `cors.mjs` (wildcard CORS wrapper), `token-crypto.mjs` (AES-256-GCM for OAuth tokens) |
| `supabase/migrations/` | 28 hand-applied SQL files, `0001`–`0026`. Prefixes `0003`, `0004` and `0005` are used twice each; there is no `0017`. The `README.md` there is stale (§6) |
| `supabase/seeds/quote_types.json` + `scripts/seed-quote-types.mjs` | Ten ready-written Mworx quote types. The script prints idempotent SQL for `bk_quote_templates` (`node scripts/seed-quote-types.mjs <user_id> > out.sql`) |
| `local-test-reminders.mjs` | Local reminder dry-run/send harness. **Broken** (see AI_HANDOFF) |
| `ios/`, `capacitor.config.ts`, `codemagic.yaml` | Capacitor iOS shell and CI to App Store Connect |
| `ANALYSIS-BookKeeper.md` | Code audit dated 2026-06-11. **Largely stale** (AI_HANDOFF lists what is fixed and what is still open) |
| `README.md` | Unmodified Vite template boilerplate. Says nothing about this app |

## 5. Key features and how they work

### 5.1 Auth
- The login screen is **sign-in only**. Sign-up was removed in `cee0420` (2026-07-07). It also has "Forgot password" (`resetPasswordForEmail` → `PASSWORD_RECOVERY` event → `ResetPasswordScreen`) and Settings → Security → Change password.
- **Unverified:** that public sign-ups are also disabled in Supabase Auth. A code comment claims so (`src/App.jsx` `LoginScreen`).

### 5.2 Data loading and tenancy
- `loadData(biz)` fetches in parallel: contacts, invoices (quotes and invoices share `bk_invoices`), profiles, jobs, Outlook connections, quote templates and scope lines. It then fetches line items and job parties for those rows. The filter is `business_id = 'mworx'` (the constant `COMPANY.id`) for every user.
- After loading, it flips `type='invoice' AND status='sent' AND due_date < today` to `overdue` and reloads the invoices.
- The view is filtered by **company** (`division`, with an "All companies" option) and by **Australian financial year** (1 Jul–30 Jun, by document `date`). Both choices are saved in `localStorage`. Numbering and project totals always use lifetime data, never the FY-filtered view.

### 5.3 Quotes and invoices
- Every document belongs to one company through its `division` column. Its letterhead, logo, bank details, mailbox and prefixes come from that company's `bk_profiles` row (`docProfile` / `docConn` in the app, `lib/company.mjs` on the server). The company the app is currently switched to plays no part.
- Pricing is either `itemised` (qty × rate) or `lump_sum` (a list of scope lines with one typed total). A leading space on a scope line marks a sub-item. A line made only of dashes, or reading "page break", is a page break.
- **Scope library** (`bk_scope_lines`): reusable lines (`heading` / `item` / `caveat`). The quote form picks from it and can save new lines back to it.
- **Quote types** (`bk_quote_templates` + `application_type`): a ready-written scope, payment plan, notes and terms for one kind of job. "New Quote" first asks for a project (`QuoteStart`). If exactly one quote type matches the project's application type, it is applied automatically; otherwise a picker is shown. "Save as quote type" replaces an existing type with the same name and application type.
- **Payment plan** (`bk_invoices.payment_plan` jsonb, `[{label, percent}]`): preset splits plus suggested labels. `planAmounts()` makes the last stage absorb rounding when the percentages add up to 100.
- **Accepting a quote** (`acceptQuote`): it refuses an empty quote, creates a project if none is linked, sets the status to `accepted`, promotes a `lead` project to `active`, and files the PDF to OneDrive. `offerDepositInvoice` then raises a draft stage-1 invoice: from the payment plan if there is one, otherwise from a typed percentage. `converted_from_quote_id` + `quote_stage` lock this to one deposit per quote. Later stages are picked from a dropdown on a new invoice for that project; stages that already have an invoice are hidden.
- **Statuses** (`DOC_STATUS` is the single source; the database has no CHECK constraint):
  - Quotes: `draft, sent, accepted, superseded, declined`.
  - Invoices: `draft, sent, paid, overdue, cancelled`.
  - Statuses can be changed from the list pill, the row menu or the form. Risky transitions ask for confirmation, and card-paid invoices cannot be un-paid.
- Other actions: duplicate a document, bulk mark paid, bulk delete (MYOB-synced documents are skipped), and quote follow-up on the dashboard (how long a sent quote has been out, and whether it has expired against `due_date`).

### 5.4 PDF generation and preview
- `generate-invoice-pdf` (POST `{invoice_id, auth_token}`) builds HTML with `buildDocHTML(mode:"pdf")`, renders A4 in Chromium with a footer template ("Page n of N"), uploads to Storage bucket `invoices` at `<business_id>/<invoice id>.pdf`, writes `pdf_path` / `pdf_generated_at`, and returns a signed URL valid for 1 hour.
- `DocViewer` shows the **real PDF** in an iframe. While the PDF renders, in edit mode, or when the function cannot be reached (localhost), it shows HTML A4 sheets instead. Edit mode writes scope, notes and terms back to the document.
- If the server PDF fails, Download falls back to a browser print of the same HTML.

### 5.5 Emailing documents (Outlook)
- Each company connects its own Outlook account: Settings → Email Sending → `outlook-oauth-start`, then Microsoft login, then `outlook-oauth-callback`. The callback encrypts the tokens and upserts `bk_email_connections` on `(user_id, business_id, provider)`. Scopes: `offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite`.
- The in-app `ComposeEmail` window prefills from the company's template. Variables: `{first_name} {last_name} {contact_name} {number} {amount} {due_date} {due_date_line} {payment_details} {business_name} {signature}`.
- When the user sends, the app regenerates the PDF and calls `send-invoice-outlook`. The function attaches the PDF (it refuses if there is no PDF or the PDF is over 3 MB), calls Graph `sendMail` (saved to Sent Items), sets draft→`sent`, and stamps `sent_at`. The function also has a `draft:true` branch that creates an Outlook draft, but the current UI does not use it.
- If the company has no mailbox connected, Email falls back to a `mailto:` link plus a PDF download, then asks whether to mark the document Sent.

### 5.6 OneDrive filing
`onedrive-upload` (POST `{kind:"invoice"|"project", id, prev_name?, prev_subfolder?}`):
- **Project creation** finds or creates `<projects base>/<job_number> - <address or name>`. The base is the company's `onedrive_folder`, falling back to the company name. A new folder is a Graph **copy of `00000 - Master Folder`**. If the master is missing or the copy fails, it gets the fallback skeleton `01 - Admin … 06 - Approvals`. The copy is asynchronous: the function polls for about 6 s and then returns `pending`.
- **Documents** file into `<project>/01 - Admin/<Quotes|Invoices>` from their first save, draft or not. A document with no project goes to `<parent of base>/Admin/<Quotes|Invoices>`. When a document is later filed to its project, the stale central copy is deleted. An existing project folder is matched by job-number prefix, so folders renamed by hand still match.
- Filing is triggered silently after create, accept, mark sent, mark paid and send. It also runs explicitly from the editor, the preview header and the row menu. OneDrive filing accepts any connected Microsoft account.

### 5.7 Automatic payment reminders
`send-reminders.mjs` is a **scheduled** function (`config.schedule = "@daily"`):
- It selects invoices with status `sent`/`overdue`, a due date, a contact email, and `due_date <= today + 3` (computed in the business timezone). Quotes are skipped.
- Thresholds:
  - A **courtesy note 3 days before due** (logged as threshold `-3`). It is skipped if the invoice was sent less than 2 days ago.
  - Then **1, 7, 14 and 30 days overdue**. Each run sends the highest threshold reached that has not been sent yet.
  - Nothing is sent on the due date itself.
- Idempotency: `bk_reminder_log` is unique on `(invoice_id, threshold)`. The function claims a row by insert or compare-and-swap before sending. A row stuck in `sending` for more than 30 min is retried.
- Emails go out through **Resend**:
  - From: `REMINDER_FROM_EMAIL` (default: a no-reply address on the Mworx domain), under the company's name.
  - BCC: `REMINDER_BCC_EMAIL` (default: the Mworx info inbox; set it to an empty string to turn BCC off).
  - Reply-To: `bk_profiles.reminder_reply_to`, falling back to the company email.
  - The private logo is swapped for a signed URL valid for 1 year.
- The function also has an HTTP mode (Bearer JWT, `?dryRun=1`, single `invoice_id` send). The in-app buttons that used it were removed or hidden (`1d0bc38`; `SHOW_MANUAL_REMINDER_CONTROLS = false`) because a scheduled function is not reachable over HTTP in production.

### 5.8 Card payments (Stripe), currently hidden
- `CARD_PAYMENTS_VISIBLE = false` (`83502ac`, 2026-10-01) hides the PDF/email "Pay by card" button, the "Copy pay link" action and the settings panel. The Stripe code and env vars are untouched.
- `pay-invoice` (public GET `?invoice=&t=<pay_token>`) validates the token and the status. It refuses quotes, paid, cancelled and $0 invoices. It creates a Checkout Session with an idempotency key and redirects to Stripe. The surcharge is grossed up so the customer covers the whole fee: `total = (base + fixed) / (1 − rate)`, with `STRIPE_SURCHARGE_PCT` (default 1.7) and `STRIPE_SURCHARGE_FIXED` (default 0.30).
- `stripe-webhook` verifies the HMAC on the raw body (5-minute tolerance). On `checkout.session.completed` it sets `paid` once, guarded by `stripe_session_id IS NULL`. It is the only code path that marks an invoice paid by card.

### 5.9 Projects, contacts, companies
- **Projects** live in `bk_jobs`. Fields include `job_number`, `address`, `application_type`, `status` and an optional `contract_value`.
  - Statuses: `active, lead, job_lost, finalised`.
  - Parties (clients and consultants) are many-to-many through `bk_job_parties`.
  - The project drawer shows contract / invoiced / paid / remaining, broken down by consultant.
- **Contacts** live in `bk_contacts` (type client/consultant). Documents store a **contact snapshot** (name, email, company, ABN, address, phone) plus a `contact_id`, derived by `contactIdFor()` and required to match exactly one contact.
- **Companies** are rows in `bk_profiles`, one per company (`0025`). Each has a logo, ABN, address, bank details, a GST-not-registered flag, email templates and signature, OneDrive folder, short name, subtitle, tagline, accent colour, invoice/quote prefixes, sort order, an archived flag and a reminder reply-to address. Companies are added and archived in Settings.

### 5.10 Vault
- `bk_vaults` holds one row per user per `business_id` (always `'mworx'` in code): salt, iteration count and the wrapped data key. `bk_vault_items` holds one ciphertext per entry. Titles are encrypted too.
- PBKDF2-SHA256 with 600,000 iterations derives a key-encryption key. That key wraps a random AES-256-GCM data key. A wrong passphrase fails the GCM tag check.
- The passphrase must be at least 10 characters. The vault auto-locks after 5 minutes idle and when the user leaves the page.
- A lost passphrase cannot be recovered. The only way out is to delete the vault after typing DELETE.
- The Vault components sit at module scope and render outside the page map, so the in-memory key survives app re-renders.

### 5.11 Mobile UI
- A viewport of 768 px or less switches to `MobileLayout`: a header, a bottom tab bar (Dashboard, Quotes, Invoices, Projects, Contacts, Vault) and card lists.
- iOS safe areas are handled (`8a808c0`).

## 6. Data model and Supabase integration

The Supabase project is `BookKeeper` (ref `yzndkdlzgegrcotfeqlp`; the URL appears in `src/supabaseClient.js` and `.env.example`), region ap-southeast-2, Postgres 17. Live facts were verified 2026-10-25: 19 public tables, all with RLS enabled, and no edge functions.

**Tenancy model.**
- Every document, project, contact, template and scope row has `business_id = 'mworx'` (the tenant) and a `user_id`.
- Documents and projects also have `division`, the **company slug**.
- `bk_profiles` and `bk_email_connections` are keyed by `business_id = company slug`. This is a different meaning of `business_id`; `0025_companies.sql` and `netlify/functions/lib/company.mjs` explain it.
- RLS policies in the migrations are owner-only (`auth.uid() = user_id`). Child tables are checked through their parent.

| Table | Used by current code | Created by a repo migration? | Notes |
|---|---|---|---|
| `bk_invoices` | Yes (quotes and invoices) | **No**, only altered (0004, 0005, 0006, 0007, 0009, 0014, 0016, 0019, 0020, 0023) | Unique `(business_id, division, type, number)` where number is not null. BEFORE DELETE trigger blocks deleting MYOB-synced rows. Columns used by code with **no migration**: `sent_at`, `pdf_path`, `pdf_generated_at`, `contact_id` (0016 says it "has always existed"), `converted_from_quote_id` |
| `bk_invoice_items` | Yes | **No** | Owner policy via parent invoice (0003) |
| `bk_contacts` | Yes | **No** | Owner policy (0003) |
| `bk_jobs` (projects) | Yes | **No**, altered 0004, 0007, 0015 | Unique `(business_id, job_number)`. `last_used_at` is used but has no migration |
| `bk_profiles` (companies) | Yes | **No**, altered 0005, 0010, 0022, 0025, 0026 | The app upserts on `(user_id, business_id)`, but no migration creates that unique constraint. Logo, bank and template columns have no migration |
| `bk_email_connections` | Yes | **No**; 0002 adds the unique index and enables RLS | Encrypted Outlook tokens. The browser selects and deletes rows directly, but **no repo migration defines a policy** for it (the live policy state is **Unverified**) |
| `bk_oauth_states` | Yes (functions only) | **No**; 0002 adds the index and RLS | 10-minute OAuth nonces |
| `bk_reminder_log` | Yes (functions only) | Yes (0001) | RLS with no policy (service role only) |
| `bk_job_parties` | Yes | Yes (0015) | |
| `bk_quote_templates` | Yes | Yes (0015, 0021) | Quote types |
| `bk_scope_lines` | Yes | Yes (0018) | CHECK on `kind` |
| `bk_vaults`, `bk_vault_items` | Yes | Yes (0024) | |
| `bk_transactions` | **No** (removed `34de1ff`) | **No**, altered 0003, 0007, 0009, 0011 | Legacy expenses; data kept |
| `bk_reconciliations` | **No** | Yes (0009, 0013) | Legacy |
| `bk_category_rules` | **No** | Yes (0012) | Legacy |
| `bk_app_data` | **No** | **No** | The original JSON-blob store, replaced by real tables in `ef9e677` (2026-05-20) |
| `bk_receipts` | **No** | **No** | Never referenced anywhere in git history. Purpose **Unverified** |
| `bk_myob_connections` | **No** | **No** | Never referenced anywhere in git history. Probably related to the planned MYOB sync (0016 "Milestone 0"). **Unverified** |

**Gaps.**
- The 8 core tables have no `CREATE TABLE` in the repo, so the schema cannot be rebuilt from the migrations.
- Three live tables have no trace in the repo at all.
- There are **no Storage bucket policies** in any migration.
- Migrations are applied by hand. Commit messages say 0014 and 0021–0026 were applied live. **Unverified:** whether every migration (in particular 0002, 0003, 0007–0013 and 0016) matches the live state.
- `supabase/migrations/README.md` only covers files up to 0010. It still says "Urgent: apply 0007–0010" and points to `scripts/apply-supabase-migrations.mjs`, which was deleted in `34de1ff`.

**Storage buckets.**
- `receipts`: company logos are uploaded here from Settings and stored as a `/object/public/` URL. The code treats the bucket as private and converts logos to signed URLs or base64 when rendering. The bucket also holds legacy expense receipts.
- `invoices`: generated PDFs.

## 7. External integrations and APIs

| Service | Used for | Where | Env vars |
|---|---|---|---|
| Supabase | DB, Auth, Storage | `src/supabaseClient.js`, all functions | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (aliases `SUPABASE_SERVICE_ROLE_KEY`, `SERVICE_ROLE_KEY`), `SUPABASE_ANON_KEY` |
| Microsoft identity + Graph (Outlook mail) | OAuth connect, send document emails with PDF | `outlook-oauth-start.mjs`, `outlook-oauth-callback.mjs`, `send-invoice-outlook.mjs` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` |
| Microsoft Graph (OneDrive) | Project folders (master-folder copy), filing PDFs | `onedrive-upload.mjs` | same as above |
| Resend | Automatic payment reminders | `send-reminders.mjs` | `RESEND_API_KEY`, `REMINDER_FROM_EMAIL`, `REMINDER_BCC_EMAIL`, `BUSINESS_TIMEZONE` |
| Stripe | Card payment Checkout + webhook (hidden by flag) | `pay-invoice.mjs`, `stripe-webhook.mjs` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SURCHARGE_PCT`, `STRIPE_SURCHARGE_FIXED` |
| Headless Chromium | PDF rendering | `generate-invoice-pdf.mjs` | — |
| MYOB | **Not integrated.** Only the inert `myob_sync_status` columns and the delete guard exist (0016) | `src/App.jsx` `myobSynced`, migration 0016 | — |
| Google Fonts | DM Sans | `index.html` | — |

Removed integrations: Anthropic (AI receipt extraction, `extract-receipt.mjs`) and bank CSV/OFX import were both deleted in `34de1ff`.

## 8. Important business rules

- **Document numbers:**
  - Format: `<prefix><YY><NNN>`, counted per company and type, continuing from the highest number for the current year (`getNextDocumentNumber`).
  - Default prefixes: `MWX`/`QMWX` (Mworx) and `MTM`/`QMTM` (MT Management).
  - Prefixes are 2–6 alphanumerics, the invoice and quote prefixes must differ, and a prefix must be unique across live companies.
  - Uniqueness is enforced by a DB index. A clash shows a "number already used" message.
- **Project numbers:** `YY###`, one sequence across all companies, starting at `YY101` (`getNextJobNumber`).
- **Default due dates:** a quote is valid for 30 days and an invoice is due in 7 days.
- **Overdue:** an invoice is overdue if its status is `overdue`, or if it is `sent` and past its due date (`isOverdue`). Quotes are never overdue.
- **Cancelled invoices** are kept as a record so the numbering has no gap. They are excluded from every total, from reminders and from the pay link.
- **Project money** (`docTotals`): contract = max(sum of accepted quotes, invoiced); remaining = contract − paid; left to invoice = contract − invoiced. Draft and cancelled invoices are not counted as invoiced.
- **Guards:**
  - A quote or invoice with no scope and no amount cannot be issued or accepted; a half-filled one asks first.
  - A card-paid invoice cannot be un-paid.
  - An invoice with `myob_sync_status <> 'not_synced'` cannot be deleted. The UI blocks it and a DB trigger raises an error.
  - Editing an issued invoice's text from the preview asks for confirmation.
- **GST:** if `gst_not_registered` is set on the company profile, "GST not applicable" is printed under the total.
- **Default quote terms:** 20 clauses (`DEFAULT_QUOTE_TERMS`), applied to new quotes only. Clause 16 (liability) is flagged in the code for legal review. Terms print on their own page.
- **Reminders:** −3 / 1 / 7 / 14 / 30 days, each sent once; never for quotes; never on the due date; timezone default `Australia/Sydney` (§5.7).
- **Card surcharge:** grossed up so the business receives the exact invoice amount (§5.8).
- **Auth:** accounts are created by an admin; there is no self sign-up in the UI.

## 9. Deployment architecture

- **Web hosting:** Netlify.
  - `netlify.toml` sets only the functions directory (`netlify/functions`, esbuild) and an SPA redirect `/* → /index.html 200`.
  - Build command and publish directory are not in the repo. They are presumably `npm run build` → `dist`, set in the Netlify UI. **Unverified.**
- **Site:** the code hard-codes `https://bkeeper.netlify.app`:
  - as `API_BASE` on native,
  - as the `URL` fallback in `send-reminders`, `pay-invoice`, `generate-invoice-pdf`, `onedrive-upload` and `outlook-oauth-callback`,
  - as the OAuth redirect and Stripe webhook URL in `.env.example`.

  The Netlify project `bkeeper` (`http://bkeeper.netlify.app`) exists (verified 2026-10-25). **Unverified:** that this project builds from this repo, and from which branch. Netlify did not report the repo link.
- **Functions:**
  - `generate-invoice-pdf`, `send-invoice-outlook`, `onedrive-upload` and `outlook-oauth-start` need a user JWT.
  - `outlook-oauth-callback` (Microsoft redirect), `pay-invoice` and `stripe-webhook` are public by design.
  - `send-reminders` is scheduled `@daily`.
  - All except `outlook-oauth-callback` use the wildcard CORS wrapper.
- **No external-module config for Chromium** in `netlify.toml`. Whether PDF generation works in production is **Unverified**, although `4856e69` relies on it for the preview.
- **CI:**
  - There is no GitHub Actions workflow (`.github/` is absent).
  - Codemagic workflow `ios-testflight` runs on push to `main`: `npm install`, `npm run build`, `npx cap sync ios`, sets the build number, creates or fetches signing files, builds the IPA, and uploads it to App Store Connect with `submit_to_testflight: false` (internal testers only).
  - Codemagic env group `supabase` holds `VITE_SUPABASE_ANON_KEY` and `CERTIFICATE_PRIVATE_KEY` (base64).
  - **Unverified:** whether the iOS build is currently succeeding and published to TestFlight.
- **Database:** migrations are applied by hand in the Supabase SQL editor or via MCP. Nothing applies them automatically.

## 10. Configuration and environment variables

Names only; never commit values. `.env` is gitignored; `.env.example` is the template.

| Variable | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_ANON_KEY` | build (Netlify + Codemagic), functions | Browser Supabase key; functions use it to verify user JWTs |
| `VITE_SUPABASE_URL` | build, functions (alias) | Supabase URL (the frontend has a hard-coded fallback). Missing from `.env.example` |
| `SUPABASE_URL` | functions | Supabase URL (no fallback in functions) |
| `SUPABASE_SERVICE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SERVICE_ROLE_KEY` | functions | Service-role key (any of the three names) |
| `SUPABASE_ANON_KEY` | functions | Optional alias for the anon key |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` | functions | Azure app registration for Outlook/OneDrive |
| `TOKEN_ENCRYPTION_KEY` | functions | 32-byte hex key for the stored OAuth tokens. Changing it forces every mailbox to reconnect |
| `RESEND_API_KEY` | functions | Reminder emails |
| `REMINDER_FROM_EMAIL`, `REMINDER_BCC_EMAIL` | functions | Reminder sender and BCC (both have code defaults) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | functions | Stripe Checkout and webhook verification |
| `STRIPE_SURCHARGE_PCT`, `STRIPE_SURCHARGE_FIXED` | functions | Surcharge rate and fixed fee. `STRIPE_SURCHARGE_FIXED` is missing from `.env.example` |
| `BUSINESS_TIMEZONE` | functions | Reminder and paid-date day maths (default `Australia/Sydney`) |
| `URL` | functions (set by Netlify) | Absolute site base for pay links and OAuth redirects |
| `ENV_SMOKE_TEST` | functions | Only used by the `send-reminders` env diagnostic |
| `CERTIFICATE_PRIVATE_KEY`, `BUILD_NUMBER` | Codemagic | iOS signing key (base64) and the auto-incremented build number |

Code-level switches: `CARD_PAYMENTS_VISIBLE` (`src/lib/card-payments.mjs`) and `SHOW_MANUAL_REMINDER_CONTROLS` (`src/App.jsx`, inside `BusinessSettings`).

## 11. Significant design decisions

- **One big component.** Forms and pages are mostly defined inside `BookkeeperApp`, so they remount whenever the parent re-renders. The code works around this deliberately:
  - `formDirtyRef`, plus per-modal draft refs (`projectDraftRef`, `invoiceDraftRef`, `quoteStartDraftRef`), keep in-progress edits alive.
  - List view state lives at the root.
  - `eslint.config.js` disables `react-hooks/static-components`, `set-state-in-effect` and `purity` for this reason.
  - Some components have been hoisted out (`ContactForm`, `BusinessSettings`, the Vault components; `8938c0d`, `2217cc7`).
- **Central write helper.** `sbWrite` / `sbInsert` check the supabase-js `{error}` result, show an alert, and return `{ok}` so callers do not close a modal on failure. `sbInsert` retries without `division` for pre-0007 schemas. For that reason, no index name may contain "division" (`0016` comment).
- **One document layout** (`doc-html.mjs`) for the PDF, the preview and preview-editing. What is shown on screen is what gets emailed.
- **Snapshot plus link.** Documents keep the contact details as printed. `contact_id` is a stable link for a future accounting sync.
- **Payment plan as jsonb** on the document (not a child table), and **scope library per line** (not per document); both reasons are in the migration comments.
- **Companies are profile rows**, keyed by the slug that documents carry in `division`; the tenant key stays `'mworx'` (`0025`).
- **MYOB delete guard is a trigger, not RLS.** An RLS-filtered delete silently removes zero rows; a trigger raises a readable error.
- **Reminders use Resend, not Outlook.** Programmatic Graph sends were once blocked by Microsoft anti-spam (`598c729`, 2026-05-23). Document emails went back to Graph later and are sent from the user's own mailbox.
- **Accounting is out of scope** (`34de1ff`). The data and columns were kept, and an archive was taken first according to the commit message.
- **Card payments are switched off by a flag**, not deleted (`83502ac`). Existing pay links still resolve to a bank-transfer page.
- **Status vocabulary lives in the UI only** (`DOC_STATUS`); the database has no CHECK constraint.

## 12. Current development status

- In use and actively developed. 203 commits on `main`, 2026-05-14 → 2026-10-10. The last activity (2026-10-10) was the company records, Vault, due-soon reminder and reply-to address work (PRs #24–#27).
- All 25 remote feature/fix branches are fully merged into `main`, and there are no open PRs (2026-10-25).
- There are no automated tests and no GitHub CI. Only the Codemagic iOS pipeline is configured.

## 13. Known limitations

- The frontend is concentrated in one ~5,500-line file. Most forms and pages are still inline components, and blocking `alert` / `confirm` / `prompt` is used throughout (64 call sites).
- Schema drift risk: the core tables, storage policies and several columns exist only in the live project (§6).
- `send-reminders` mixes a scheduled job and an HTTP endpoint. Its HTTP path is not usable in production, and an unauthenticated non-dry-run request would follow the global cron path. The HTTP reachability of a scheduled function is **Unverified**.
- Money is calculated with JS floats on the client; `planAmounts` rounds per stage.
- The whole tenant is loaded on every page load (all contacts, documents and items).
- Card payments, manual reminder controls and the Outlook draft path are present in the code but switched off or unused.
- MYOB columns exist, but nothing syncs.
- The login screen and `<title>` brand the app as MT Management, while the default letterhead is Mworx Group (`COMPANY.name`, `index.html`).

## 14. Planned future improvements

Only what the repo shows:
- **MYOB integration.** `0016` is described as "Milestone 0 for the MYOB integration"; sync-status columns and a delete guard are ready, and nothing writes them yet. A `bk_myob_connections` table exists live (no code).
- **Card payments.** They can be re-enabled by setting `CARD_PAYMENTS_VISIBLE = true` (`src/lib/card-payments.mjs` comment).
- **Legal review of quote terms clause 16.** Flagged in a code comment.
- **`ANALYSIS-BookKeeper.md` recommendations still open:** split `send-reminders`, baseline the schema, add storage policies, harden OAuth state, add security headers, keep hoisting components, replace `alert` / `confirm` (status per item in AI_HANDOFF).

There is no roadmap/PLAN document and there are no TODO/FIXME markers in the code.

## 15. Unverified / open questions

- **Unverified:** whether Netlify project `bkeeper` builds from this repo, from `main`, with `npm run build` → `dist`.
- **Unverified:** whether the iOS build is currently passing in Codemagic and available to TestFlight internal testers.
- **Unverified:** whether every repo migration is applied live, and the live RLS policies on `bk_email_connections` (the browser reads and deletes it directly; no repo policy exists) and on the storage buckets.
- **Unverified:** the purpose and contents of the live tables `bk_receipts` and `bk_myob_connections`, which have no trace in the repo.
- **Unverified:** whether public sign-up is disabled in Supabase Auth.
- **Unverified:** whether headless Chromium PDF generation works reliably in production without `external_node_modules` / timeout config.
- **Unverified:** whether a scheduled Netlify function is reachable over HTTP in this deployment (commit `1d0bc38` says it is not).
