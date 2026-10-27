# BookKeeper — AI handoff

Current state, work in progress, known bugs and next tasks. Rewrite the
sections rather than appending forever. Last updated: 2026-10-27 (Sydney).

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
- Live database: 0027 to 0031 are applied (27 Oct 2026).
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
  and the run would find that folder already there. Michel to decide whether
  to add the two existing Energy jobs to Bookkeeper.

## In progress — Inbox

- [ ] Merge `feat/inbox` so Netlify deploys the page (the database and the
      runs are already ahead of the deployed app: until the deploy, proposal
      items show under their kind with no "Draft quote" button, and Focus is
      not visible — nothing breaks).
- [ ] First run after the deploy: check the Focus card, that ticking Done stops
      an item being re-raised, and that a proposal item lands with a draft
      quote linked ("Open quote") and a holding reply in Drafts.

## Known issues / debt

- `src/App.jsx` lint: `'_d' is assigned a value but never used` (pre-existing
  on `main`). The build passes.
- Inline components inside `BookkeeperApp` remount on every parent render (see
  `ANALYSIS-BookKeeper.md` §1.4). New stateful pages must be module scope.
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

## Next tasks (ideas, not committed)

- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Proposals: attach the quote PDF to the holding reply once Michel has
  approved the fee (needs a "fee approved" step; deliberately not automatic).
