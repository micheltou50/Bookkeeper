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
`bk_myob_connections` · **`bk_inbox_items`, `bk_inbox_runs`** (migrations 0027–0032).

## Inbox (Oct 2026)

Two Claude scheduled tasks ("Mworx morning inbox" ~7:12am and "Mworx close-off"
~4:15pm Sydney, every day) read the three Outlook mailboxes (info@, accounts@,
energy@mworxgroup.com.au), file attachments from the OneDrive `Attachments`
staging folder into job folders, draft replies/chases in Outlook, and treat
**Bookkeeper as the source of truth**: they read `bk_jobs` (job register),
`bk_invoices` (paid/overdue), `bk_contacts`, and write their findings into
`bk_inbox_items` via the Supabase MCP connector (service role, `user_id` set
explicitly). Each run also writes a `bk_inbox_runs` row (status, summary,
counts) that the page shows as "Last run". **All run writes go through the
`bk_inbox_*` functions** (migration 0031: `open_run`, `write_items`,
`mark_done`, `close_run`) called with SELECT: the connector stops a raw
UPDATE / upsert statement for a confirmation that a scheduled run cannot
give, and the 27 Oct close-off wrote nothing because of it.

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
  `reply` item only when info@ Sent Items shows a message in that conversation
  after the item was raised (a vanished draft is not evidence); a `chase` stays
  open until what was chased arrives — a chase Michel has sent refreshes the
  detail ("chased 27 Oct") and drops the draft link.
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
  (`draft_link`, `email_link`), to the filed file (`file_link`, "Open file"),
  to the job (`job_id` → opens the project) and to the invoice or quote
  (`invoice_id` → opens the document).
- **Drafts are ready to send** (28 Oct 2026): every run-made draft is a reply
  draft on the message (full history quoted, threaded), one `<p>` per
  paragraph, in Michel's voice, and ends with the approved text signature in
  `docs/email-signature.html` (Regards / Michael T. / mobile / website link /
  disclaimer) — once, never a bare "Regards, Michael T.". No `[placeholders]`,
  no fee or date he hasn't written, nothing "attached" (the connector cannot
  attach), one draft per thread, and the run reads every draft back before it
  links it. Why text only: the Microsoft 365 connector rejects any `style` /
  `class` / `id` attribute and any image, so the Outlook signature's green
  bar, fonts and logo cannot be reproduced; and Outlook never adds a
  signature to a Graph-created draft, even when it is sent from Outlook
  (the 27 Oct TAA chase went out with none). Drafts can only be created in
  info@ (the draft tools have no mailbox / From parameter), so accounts@ /
  energy@ mail gets a `reply` item with the suggested wording in `detail`,
  and an email that must carry a document gets an item saying what to attach
  (with `file_link`) instead of a draft.
- **Runs verify themselves** (migration 0032): `bk_inbox_items.file_link` (the
  OneDrive webUrl of a filed file — a file is "filed" only once the run has
  seen it at its destination), `bk_inbox_runs.qa` (one entry per action —
  draft, file, folder, quote, items, done — with `completed` / `partial` /
  `failed` and the evidence read back), written by `bk_inbox_run_qa(run_id,
  qa)` as the run's last write; it adds its own findings (a proposal with no
  quote, a draft with no link, a filed item with no file link) and moves an
  `ok` run to `partial` when anything is not completed. "Last run" on the
  Inbox page shows the counts and the flagged entries; the run's message
  carries a "Checked:" line from the same numbers. `bk_inbox_write_items`
  now clears a link passed as JSON null (omitted or empty keeps it).

## Outlook drafting — the Inbox API (28 Oct 2026)

`netlify/functions/inbox-api.mjs` is the one door the scheduled runs use to
change anything: Outlook drafts and the Inbox rows. Reading stays on the
Microsoft 365 and Supabase connectors; every write goes through this
function, which authenticates a bearer key (sha256 in `bk_inbox_api_keys`,
the key itself in Supabase Vault as `inbox_api_key`, migration 0033 — issued
and rotated by `bk_inbox_api_key_issue()`, which never prints it), uses the
app's own Outlook connection (`bk_email_connections`, the one that sends
invoices, refreshed with the scopes it already holds and never more) and the
service role, and never sends: `scripts/inbox-api-test.mjs` asserts the
source has no sending call.

- `draft` creates a reply / reply-all / new draft in info@, accounts@ or
  energy@. The shared mailboxes need the delegated scope
  `Mail.ReadWrite.Shared`, which the OAuth start / callback request since
  28 Oct and which is granted when Outlook is reconnected in Settings →
  Email Sending; until then the API refuses them with
  `shared_mailbox_scope_missing`. Graph builds the reply (history quoted,
  thread and recipients kept); the run's paragraphs go above it in his
  compose font, then the full signature from `lib/signature.mjs` — the table
  from his own sent mail, the green bar, Calibri, the link, the disclaimer,
  and the logo and divider line as inline attachments (`lib/assets/*.png`,
  embedded in `lib/signature-images.mjs`, referenced by `cid:`). OneDrive
  files (`attachments: [{drive_id, item_id}]`, up to 5, 8 MB each; over 3 MB
  through an upload session) are attached. The draft is then read back and
  checked: it is a draft, same conversation, the signature once, both images
  attached, no placeholders, every file present with its size; one that
  fails is deleted and reported. One draft per conversation unless
  `allow_existing`.
- The text is refused before anything is created when it carries a
  `[placeholder]`, its own sign-off, an image, a script, or mentions an
  attachment while no file is given (`lib/inbox-draft.mjs`,
  `checkOutgoingHtml`).
- Also: `draft_read`, `draft_delete` (drafts only), `drafts_find`,
  `message_read` (raw HTML and attachment list, for checks), and the Inbox
  writes `run_open`, `run_items`, `run_done`, `run_close`, `run_qa`,
  `quote_draft`, which call the `bk_inbox_*` / `bk_draft_quote_from_proposal`
  functions with the service role after an ownership check. The runs no
  longer write to the database with SELECTs that call functions.
- Tests: `node scripts/inbox-api-test.mjs --offline` (template, composition,
  checks, no-send); with `INBOX_API_URL`, `INBOX_API_KEY` and
  `TEST_MESSAGE_ID` the online run (ping, a reply draft with signature and
  attachment, read-back, duplicate refusal, error paths, shared-mailbox gate,
  clean-up; `KEEP=1` leaves the drafts for a look in Outlook). The offline
  run also writes `lib/assets/signature-preview.html` for a browser preview.
- `docs/email-signature.html` remains the text fallback for drafts made
  through the connector; drafts made through the API carry the full one.

## Numbering

- Quotes and invoices: `<company prefix><YY><seq>` from `bk_profiles`
  (`QMWX26017`, `ME26001` …), per company (`getNextDocumentNumber`).
- Projects: **Mworx Energy has its own sequence**, `YY1###` from `YY1001`
  (`261001` …), as its OneDrive folders are named. The other companies share
  the single `YY###` sequence from `YY101` (`26101` …). `getNextJobNumber(jobs,
  divisionId)` in the app and `bk_draft_quote_from_proposal` follow the same
  rule. A company's jobs must be in `bk_jobs` for the count to continue from
  them — Energy's two OneDrive folders (261001, 261002) were not in Bookkeeper
  on 27 Oct.

## Conventions

- Australian English, AUD, Sydney time for anything date-shaped.
- Prefer reviewable branches/PRs; never push straight to `main`.
- After a significant change: update this file if architecture/features/
  integrations changed, update `AI_HANDOFF.md`, commit both with the code.
