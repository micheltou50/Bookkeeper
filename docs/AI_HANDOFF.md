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
  proposal rows).
- Live database: 0027, 0028 and 0029 are applied (27 Oct 2026).
- Scheduled runs ("Mworx morning inbox" ~7:12am, "Mworx close-off" ~4:16pm
  Sydney) updated 27 Oct: they set `focus`, raise `proposal` items with a
  holding reply, and call `bk_draft_quote_from_proposal` for each open
  proposal without a quote.

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

- Inbox: "Mark paid" shortcut on `money` items (the row already opens the invoice).
- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Runs: when a chase/reply draft is sent from Outlook, auto-mark the item done
  (needs the close-off run to check Sent Items against open items).
- Runs: when a drafted quote is sent from Bookkeeper, mark its proposal item
  done (the quote's `sent_at` is enough to tell).
- Proposals: attach the quote PDF to the holding reply once Michel has
  approved the fee (needs a "fee approved" step; deliberately not automatic).
