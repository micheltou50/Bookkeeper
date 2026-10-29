# BookKeeper — AI handoff

Current state, work in progress, known bugs and next tasks. Rewrite the
sections rather than appending forever. Last updated: 2026-10-28 (Sydney).

## Status

- `main` = PR #27 (reminder reply-to) merged.
- Branch `feat/inbox` (PR #29, open) adds the Inbox feature: migration
  `0027_inbox.sql`, `InboxPage`, nav badge, dashboard rows, these docs; then
  **Focus** (`0028_inbox_focus.sql`: Focus card and pill, "Add a task", kinds
  `proposal` and `task`, badge and dashboard / mobile rows counting Focus,
  "Open invoice / quote" on rows with an `invoice_id`); then **fee proposals**
  (`0029_draft_quote.sql`: `bk_draft_quote_from_proposal`, "Draft quote" on
  proposal rows); then **items follow their documents** (`0030`: trigger on
  `bk_invoices`, "Mark paid" on money rows, lead folders from the Draft quote
  button).
- Live database: 0027 to 0034 are applied (0032 to 0034 on 28 Oct 2026), plus
  the data the runs rely on: the "BASIX — Certificate" quote type (6 standard
  scope lines, no fee) and the Inbox API key in Vault.
- Review fixes (28 Oct, from Michel's independent review of PR #29): (1) job
  numbers — `bk_next_job_number` and the `bk_jobs_number_guard` trigger
  (0034) keep production right before this branch deploys (verified in a
  rolled-back test: a Mworx Group insert with 261004 becomes 26119, an Energy
  insert with no number becomes 261004, MT Management continues the 5-digit
  sequence, a hand-typed "26118A" is kept, a duplicate is refused); (2) Mark
  paid from the Inbox — Michel's edit (only sent / overdue invoices, never
  quotes, a confirmation, the result checked) kept and extended with the
  client and amount in the confirmation and a read-back of the row as paid
  before the item closes; the 0030 trigger closing the money item verified
  in the same rolled-back test; (3) quotes — each proposal item gets its own
  draft, no fee is ever assumed, the BASIX quote type carries the standard
  scope, both run prompts carry the new rules; (4) Sydney calendar dates for
  Focus, due and overdue — Michel's `inboxSydneyDate()` kept and tested at
  midnight in both regimes and across both daylight-saving changeovers (13
  cases, all pass).
- Scheduled runs ("Mworx morning inbox" ~7:12am, "Mworx close-off" ~4:16pm
  Sydney) updated 27 Oct: they set `focus`, raise `proposal` items with a
  holding reply, call `bk_draft_quote_from_proposal` for each open proposal
  without a quote, copy the master folder for a lead it created, and close a
  reply / chase item once info@ Sent Items shows it was sent. Since the
  evening of 27 Oct they write only through the `bk_inbox_*` functions.
- Diagnosis 27 Oct: the 4:16pm close-off ran, found a quiet day, then its
  write (item upsert + run update in one statement) stalled on the
  connector's confirmation prompt and nothing was saved; its run row sat as
  "ok" with no summary. Root cause: the connector questions any statement
  that looks like an UPDATE. Fix: migration 0031 + both prompts rewritten to
  call the functions with SELECT; the run row was corrected to status
  "error" with the explanation. The 28 Oct 7:12am morning run is the first
  on the new write path — check its run row has a summary and counts.
- BASIX (27 Oct evening): the runs route BASIX / NatHERS mail to
  `mworx_energy` by subject matter, matching the filing rule, and pass
  `BASIX` as the application type. There is no BASIX quote type (Michel's
  call), so a BASIX proposal drafts with one scope line to fill in, no fee
  suggestion and no terms to copy; numbered `QME26nnn`.
- Project numbers (27 Oct): Mworx Energy now has its own `YY1###` sequence
  from 261001 in the app and in the draft-quote function. OneDrive already
  holds Energy folders 261001 and 261002 that are not in `bk_jobs`; until
  they are added as projects, the next Energy lead would be numbered 261001
  and the run would find that folder already there. 28 Oct: the two Energy
  jobs were added (261001 Prospect Road, 261002 Stephanie Street, both
  "active" / BASIX), the test lead was renumbered 261003 and the clash item
  closed. `bk_jobs` has unique indexes on (business_id, job_number) and on
  the lower-cased name per business; the draft-quote function now falls back
  to the address, then the number, when a lead name is taken.
- Quality pass (28 Oct): an audit of the live drafts and run output found
  (1) no run-made draft carried a signature — the run's TAA chase went out
  from Michel's phone on 27 Oct 11:40pm with no signature and stray spaces,
  because Outlook never adds a signature to a Graph-created draft; (2)
  placeholders ("[day]", "$[fee] + GST", "[Fee proposal attached.]") in three
  drafts, one claiming an attachment that cannot exist; (3) the TAA chase
  item said "You chased 27 Oct (7:28am)" for what was only the run's own
  draft (drafts surface in recipient searches); (4) filed / created / drafted
  was only ever reported from intention, never read back. Fixes: migration
  0032 (`file_link`, `qa`, `bk_inbox_run_qa`, null-clearing links) applied
  live; both prompts rewritten — a DRAFTS section (approved signature from
  `docs/email-signature.html`, no placeholders, no attachment claims, one
  draft per thread, read-back of every draft before it is linked, shared-
  mailbox mail as an item carrying the wording), filing verified at the
  destination before a `file` item, a QA entry per action as the run's last
  write, and a "Checked:" line in the message. Live clean-up: the Seda and
  Sarah holding replies re-made with the signature and no placeholders, the
  stale TAA draft (a duplicate of what he sent) removed, the chase item
  corrected. A test draft "Signature test — do not send" is in info@ Drafts
  for Michel to view in Outlook and delete. The NKD draft of 26 Oct ("$[fee]
  + GST … [Fee proposal attached.]") belongs to an item he dismissed, so it
  was left for him.
- Outlook drafting through Bookkeeper (28 Oct, built, not yet live):
  `inbox-api.mjs`, `lib/signature.mjs` (the real signature: logo, green bar,
  Calibri, link, divider, disclaimer), `lib/inbox-draft.mjs`,
  `lib/signature-images.mjs`, `lib/inbox-links.mjs` (linked documents),
  migration 0033 (applied live; a key issued into Vault, never printed), the
  OAuth consent now asks for `Mail.ReadWrite.Shared`, and
  `scripts/inbox-api-test.mjs` (18 offline tests pass). Added 28–29 Oct:
  the read-state promise (the API never writes `isRead`; every op that
  touches a message reads the flag before and after and reports it — no
  automatic "back to unread", Michel's rule of 29 Oct: his read / unread
  decisions stand), the linked-document ops `links_scan`, `links_fetch`
  (chunked through an encrypted transfer token carrying a running
  QuickXorHash, cancel and session-lost handling, verified at the
  destination against OneDrive's hash), `attachment_fetch` and
  `file_verify`, and `scripts/inbox-api-live.mjs` for the live sequence —
  see AI_CONTEXT. None of it has run against Microsoft
  Graph: this environment's network policy refuses `bkeeper.netlify.app`,
  `deploy-preview-29--bkeeper.netlify.app` and `graph.microsoft.com`; Michel
  is to allow them under the environment's Network access (the scheduled
  runs need the same before they can use the API). Then: run the online
  tests against the deploy preview, compare the logo and line display sizes
  with the raw HTML of a sent email (`message_read`), screenshot, test
  `links_fetch` on Seda's Mail Drop links into a test folder, reconnect
  Outlook for the shared mailboxes, switch both run prompts to the API,
  rotate the key.
- Verification before merge (28 Oct evening, all against isolated data —
  nothing live was written): (1) `scripts/regression/pure-functions.mjs`:
  18 helper cases pass on the branch, 15 identical to main, the 3 job-number
  cases intentionally different; (2) `scripts/regression/ui-flows.mjs`
  (Playwright + in-process Supabase stand-in, see AI_CONTEXT): branch 17/17
  at desktop and phone size, main 15/15 at both; every write the original
  flows make (contact insert/update, project insert per company, quote
  insert with the DA quote type's scope, accept + 30 % deposit invoice,
  invoice insert with its line, mark paid, the Outlook send calls, the
  OneDrive refile calls) is identical on branch and main except the project
  number the form shows and sends — main shows/sends `261004` for a Mworx
  Group project and the database guard (0034) corrects it to `26119`; the
  branch shows and sends `26119`; (3) the Inbox page on the branch: Mark
  paid asks with client and amount, patches, reads the row back
  (`select=id,status,paid_date`) and the item closes through the 0030
  trigger; Draft quote calls `bk_draft_quote_from_proposal` once and links
  the draft; (4) RLS as the `authenticated` role (rolled back) and a review
  of every trigger, policy and function on the live project: only the
  expected 0030 / 0034 additions; (5) lint: the pre-existing `_d` error on
  main only; build passes.
- Prompts (28 Oct evening): both runs carry READ STATE (record isRead from
  the search before read_resource, never run anything that marks read,
  re-search afterwards and report any flip in QA and the message) and
  JOB 1b (linked documents: list and classify every download link in the
  body; today a 'call' item carrying the original links, never "downloaded";
  with the API, `links_fetch` and a verified 'file' item). Stored prompts
  verified byte-identical to `scratchpad/prompts/morning.txt` /
  `closeoff.txt` (derived by `derive.py`).

## In progress — Inbox

- [ ] Merge `feat/inbox` so Netlify deploys the page (the database and the
      runs are already ahead of the deployed app: until the deploy, proposal
      items show under their kind with no "Draft quote" button, and Focus is
      not visible — nothing breaks).
- [ ] First run after the deploy: check the Focus card, that ticking Done stops
      an item being re-raised, and that a proposal item lands with a draft
      quote linked ("Open quote") and a holding reply in Drafts.
- [ ] First runs on the 28 Oct prompts (morning 29 Oct, close-off 29 Oct):
      the run row has `qa` entries and the message a "Checked:" line; every
      new draft ends with the signature once and has no brackets; a filed
      file has "Open file"; nothing was reported that was not read back; the
      Checked line says "Read state: unchanged" (or lists the flips); Seda's
      email (12 Cobbler Crescent) produces one "Linked documents to download"
      call item listing its 15 Mail Drop files.
- [ ] Michel: an unread test email to info@ (and one each to accounts@ /
      energy@) so the read-state check can be proven on an unread message —
      every message in info@ was already read on 28 Oct, so the promise is
      verified by construction (Graph GETs do not change isRead; the API
      restores) but not yet by a live before/after.
- [ ] Migration 0035 (not applied): apply only with Michel's approval. Tested
      29 Oct in a rolled-back block against the live project, side by side
      with the live function: a quote type with `lump_amount` 5000 gives a
      $5,000 draft under 0034 ("ready at $5,000 (quote type amount — check
      it)") and a $0 draft under 0035; an itemised type with rates 1500 +
      3500 gives $5,000 under 0034 and $0 under 0035 (the rates stay on the
      lines for him to see); BASIX $0 with the six lines either way;
      `p_amount` 1234 ignored; leads, contacts and quotes rolled back —
      residue check zero, function still 0034.
- [ ] Live Inbox API tests: blocked until `deploy-preview-29--bkeeper.netlify.app`
      is allowed in the Claude environment's Network access (Limited level,
      Allowed domains); then `scripts/inbox-api-live.mjs` with the key moved
      into the sandbox encrypted (never printed), Seda's email as the
      linked-document case (job 26102, 12 Cobbler Crescent Minchinbury,
      status job_lost), and three unread test emails Michel sends to info@,
      accounts@ and energy@.
- [ ] After the live tests pass: both run prompts switch linked documents
      from a 'call' item to `links_fetch` (flag only expired / sign-in /
      uncertain job / unsafe / failed), with the key read by the run from an
      environment variable, never from Vault into its transcript.

## Known issues / debt

- `src/App.jsx` lint: `'_d' is assigned a value but never used` (pre-existing
  on `main`). The build passes.
- Inline components inside `BookkeeperApp` remount on every parent render (see
  `ANALYSIS-BookKeeper.md` §1.4). New stateful pages must be module scope.
  `InboxPage` is module scope but sits under the inline `MobileLayout`, so on
  the phone it is still remounted on every parent render; it keeps its rows,
  filter, "Show done" and open row in a module memo (`inboxPageMemo`) so a
  tick does not reset the view (Codex finding, fixed 28 Oct). The page loads
  in three slices (open to-do kinds, newest 500 record rows, newest 500 closed
  rows under "Show done") so filed rows can never push an open item out of
  the fetched set (Codex finding, fixed 28 Oct).
- `bk_inbox_items.division` is set by the runs from the matched job (or the
  mailbox); items whose job sits in another company are shown under
  "All companies" only.
- `today()` is the UTC date (app-wide convention: invoice dates, paid dates,
  reminders). The Inbox no longer uses it — `inboxSydneyDate()` gives the
  Sydney calendar date for Focus, due and overdue — but a paid date set from
  the app is still the UTC date, which is yesterday's date before 10–11am
  Sydney.
- `bk_draft_quote_from_proposal` copies `terms` from the last quote in the
  division because the app's default quote terms live in the front end
  (`DEFAULT_QUOTE_TERMS`). If those defaults change, the first quote created
  from the app carries them forward.
- No quote type has a `lump_amount`, so a drafted quote's fee is the run's
  suggestion from comparable accepted / sent quotes (or 0 = "price it").
  Setting `lump_amount` on a quote type makes that fee fixed.
- The Microsoft 365 connector cannot create a draft in accounts@ or energy@
  (the draft tools have no mailbox / From parameter — every draft is from
  info@), cannot attach a file or image to a draft, and rejects `style` /
  `class` / `id` attributes, so the Outlook signature's logo, fonts and
  green bar cannot be reproduced; the text signature in
  `docs/email-signature.html` is the agreed stand-in. Full fidelity (logo,
  attachments, sending as a shared mailbox) needs a Bookkeeper-side Graph
  call: the app already holds a delegated token with `Mail.ReadWrite
  Mail.Send` (`netlify/functions/send-invoice-outlook.mjs`), so an
  `inbox-draft` function could create the draft with the inline logo and
  attach the quote PDF from OneDrive, and the runs would call it over HTTPS
  with a secret. Sending as accounts@ / energy@ also needs "Send As" on each
  shared mailbox from the Microsoft 365 admin centre. The Bookkeeper-side
  function now exists (`inbox-api.mjs`, above); Send As on the shared
  mailboxes is still unknown and unchanged, so a draft the API saves in
  accounts@ or energy@ may not send as that mailbox until the admin grants
  it.
- Netlify synchronous functions stop at 10 s on this plan, which is the real
  limit on attachments the API can carry (a few MB; `MAX_ATTACHMENT_BYTES`
  is 8 MB). Larger documents stay an item telling Michel what to attach.
  `links_fetch` works around the limit for downloads by moving 2.5 MB per
  call and carrying its state in an encrypted transfer token (a 10 MB file
  is about five calls); whether Apple's and Dropbox's CDNs honour byte
  ranges as expected is untested until the network allowance is granted.
- The connector's `read_resource` is a Graph GET and should not change
  `isRead`, but no unread message existed in info@ to prove it on 28 Oct;
  the prompts compare before/after and report a flip, and the API reports
  `read_state` on every op. Nothing restores or sets `isRead`: a change is
  Michel's and stays (his rule, 29 Oct). The prompts' READ STATE paragraph
  still says the API "restores unread" — to be corrected in the next prompt
  update (the API switch), since it describes a path not yet in use.
- WeTransfer, OneDrive / SharePoint share links and portals are not fetched
  (a browser or sign-in is needed); they become 'call' items with the link.

## Next tasks (ideas, not committed)

- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Proposals: attach the quote PDF to the holding reply once Michel has
  approved the fee (needs a "fee approved" step; deliberately not automatic).
- Inbox: `inbox-draft` Netlify function (Graph, Bookkeeper's own token) so
  run drafts carry the real Outlook signature with the logo and can attach
  the quote PDF from OneDrive; then Send As for the shared mailboxes. Needs
  approval.
