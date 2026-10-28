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
- Live database: 0027 to 0032 are applied (0032 on 28 Oct 2026).
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
      file has "Open file"; nothing was reported that was not read back.

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
- `today()` is the UTC date (app-wide convention), so Focus's "due today"
  flips at 10–11am Sydney rather than at midnight.
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
  shared mailbox from the Microsoft 365 admin centre. Neither is done:
  Michel's approval needed.

## Next tasks (ideas, not committed)

- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Proposals: attach the quote PDF to the holding reply once Michel has
  approved the fee (needs a "fee approved" step; deliberately not automatic).
- Inbox: `inbox-draft` Netlify function (Graph, Bookkeeper's own token) so
  run drafts carry the real Outlook signature with the logo and can attach
  the quote PDF from OneDrive; then Send As for the shared mailboxes. Needs
  approval.
