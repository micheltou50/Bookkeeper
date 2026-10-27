# BookKeeper — AI context

Shared, durable understanding of this app for any assistant (Claude, ChatGPT,
Cursor) working on it. Keep it accurate: update when architecture, features or
integrations change, and commit it with the code. Day-to-day state lives in
`AI_HANDOFF.md`.

## What it is

Michel Toubia's bookkeeping and job-admin app for his companies: **Mworx Group**
(`mworx`, drafting and planning), **Mworx Energy** (`mworx_energy`, BASIX/NatHERS)
and **MT Management** (`mt_management`, short-term rentals). Quotes, invoices,
projects (jobs), contacts, expenses/bank reconciliation, an encrypted Vault, and
— from Oct 2026 — an **Inbox** fed by the scheduled email runs.

## Stack

- **Frontend:** Vite + React 19, one file `src/App.jsx` (~5.8k lines). Most
  components are declared *inside* `BookkeeperApp`, so they remount on every
  parent render (see the `formDirtyRef` / draft-ref comments). Components that
  must keep state across renders are module scope: `BusinessSettings`,
  `VaultPage`, `InboxPage`, `ContactForm`.
- **Data:** Supabase project `yzndkdlzgegrcotfeqlp` (ap-southeast-2). The
  browser uses the anon key + RLS (`auth.uid() = user_id`). All rows carry
  `business_id = 'mworx'` (one tenant); the company is the `division` column.
- **Backend:** Netlify functions (`netlify/functions/*.mjs`, service-role key,
  bypass RLS): invoice PDF, Outlook OAuth + send, OneDrive upload, Stripe
  pay/webhook, scheduled overdue-invoice reminders (`send-reminders.mjs`).
- **Mobile:** Capacitor iOS shell (`ios/`, `capacitor.config.ts`); API base is
  `https://bkeeper.netlify.app` on native.
- **Migrations:** `supabase/migrations/*.sql` are hand-applied (see its README);
  they document the live schema rather than create it from scratch.

## Tables (public.bk_*)

`bk_profiles` (one row per company: name, ABN, bank, prefixes, OneDrive folder,
reminder reply-to) · `bk_jobs` (job register: `job_number`, `address`, `status`
lead/active/finalised/job_lost, `division`) · `bk_job_parties` · `bk_contacts`
(client/consultant/supplier) · `bk_invoices` (+ `bk_invoice_items`; quotes and
invoices share the table via `type`) · `bk_quote_templates`, `bk_scope_lines` ·
`bk_transactions`, `bk_receipts`, `bk_reconciliations`, `bk_category_rules` ·
`bk_email_connections` (Outlook OAuth tokens), `bk_oauth_states` ·
`bk_reminder_log` · `bk_vaults`, `bk_vault_items` (zero-knowledge) ·
`bk_myob_connections` · **`bk_inbox_items`, `bk_inbox_runs`** (migrations 0027–0030).

## Inbox (Oct 2026)

Two Claude scheduled tasks ("Mworx morning inbox" ~7:12am and "Mworx close-off"
~4:15pm Sydney, every day) read the three Outlook mailboxes (info@, accounts@,
energy@mworxgroup.com.au), file attachments from the OneDrive `Attachments`
staging folder into job folders, draft replies/chases in Outlook, and treat
**Bookkeeper as the source of truth**: they read `bk_jobs` (job register),
`bk_invoices` (paid/overdue), `bk_contacts`, and write their findings into
`bk_inbox_items` via the Supabase MCP connector (service role, `user_id` set
explicitly). Each run also writes a `bk_inbox_runs` row (status, summary,
counts) that the page shows as "Last run".

- Kinds: `chase`, `reply`, `proposal` (a fee proposal to price and send),
  `deadline`, `money`, `call` (needs Michel's call), `task` (typed in on the
  Inbox page), `fyi`, `file` (filed), `skipped`. The first seven are his to-do
  (`INBOX_ACTION_KINDS`); the rest are the run's record.
- **Focus** (migration 0028, `focus boolean`, three-valued): the short list on
  top of the growing record — what he is doing today. `true` = pinned (app or
  run), `false` = taken out, `null` = the app decides: open and a chase, a
  proposal, a task, or due today / overdue → in Focus (`inboxInFocus`). The nav
  badge and the dashboard / mobile rows count Focus, not the whole open list.
  "Add a task" on the page inserts a `task` row (`dedupe_key task:<uuid>`,
  `source_run manual`, `focus true`). The runs set `focus = true` on what he
  must do today (chases, proposals, stale replies, deadlines due, money);
  their upsert leaves the column alone on refresh, so pins and removals
  survive.
- **Fee proposals** (migration 0029): a quote request becomes a `proposal`
  item (`dedupe_key proposal:<conversationId>`) plus a holding-reply draft in
  Outlook; the run then calls `bk_draft_quote_from_proposal(item_id,
  application_type, works, suggested_fee, template_id, client_company)`,
  which does what the app's quote form does server-side — next quote number
  for the division, the quote type's scope lines with `[address]` and the
  works filled in, notes, payment plan, terms copied from the last quote,
  the client linked or created, a `lead` job created when the address has
  none — saves it as a draft and sets the item's `invoice_id`. The Inbox row
  then shows "Open quote"; "Draft quote" on the row calls the same function
  (rpc) by hand, and gives a new lead its OneDrive folder the way
  `createProject` does (`saveToOneDrive("project")`); the runs copy the master
  folder for a lead the function created — the one folder they may create.
  The fee is a suggestion from comparable quotes (no quote type carries a
  `lump_amount` yet); nothing is sent without Michel.
- **Items follow their documents** (migration 0030, trigger on `bk_invoices`):
  a quote sent / accepted marks its `proposal` item done (declined →
  dismissed); an invoice sent / paid marks its `money` item done (superseded /
  cancelled → dismissed). "Mark paid" on a money row uses it. The runs close a
  `reply` / `chase` item only when info@ Sent Items shows a message in that
  conversation after the item was raised (a vanished draft is not evidence).
- `dedupe_key` is unique per user (`reply:<internetMessageId>`,
  `chase:<conversationId>:<promised_at>`, `file:<OneDrive path>` …). Runs upsert
  on it and only touch rows still `open`.
- Status `open` → `done` (ticked) or `dismissed` ("Don't flag again"). The runs
  skip anything not `open`, so ticking an item in the app is what stops it
  coming back. Reopen is available under "Show done".
- `InboxPage` (module scope) loads its own rows; `BookkeeperApp` keeps a light
  `inboxOpen` list (`fetchInboxOpen`, which falls back to the 0027 columns
  until 0028 is applied) for the badge and dashboard and refreshes it via
  `refreshInbox` after a change. Rows link to the Outlook draft/email
  (`draft_link`, `email_link`), to the job (`job_id` → opens the project) and
  to the invoice or quote (`invoice_id` → opens the document).

## Conventions

- Australian English, AUD, Sydney time for anything date-shaped.
- Prefer reviewable branches/PRs; never push straight to `main`.
- After a significant change: update this file if architecture/features/
  integrations changed, update `AI_HANDOFF.md`, commit both with the code.
