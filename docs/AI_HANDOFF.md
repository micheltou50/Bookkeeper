# BookKeeper — AI handoff

Current state, work in progress, known bugs and next tasks. Rewrite the
sections rather than appending forever. Last updated: 2026-10-27 (Sydney).

## Status

- `main` = PR #27 (reminder reply-to) merged.
- Branch `feat/inbox` adds the Inbox feature (this handoff): migration
  `0027_inbox.sql`, `InboxPage`, nav badge, dashboard rows, these docs.

## In progress — Inbox

- [ ] Apply `supabase/migrations/0027_inbox.sql` to the live project (additive:
      two new tables + RLS). Until it exists, the Inbox page shows a "tables
      aren't set up yet" notice and the badge stays empty; the scheduled runs
      report a failed write.
- [ ] Merge `feat/inbox` so Netlify deploys the page.
- [ ] First real run writes rows → check the "Last run" card and that ticking
      Done stops an item being re-raised next run.

## Known issues / debt

- `src/App.jsx` lint: `'_d' is assigned a value but never used` (pre-existing,
  line ~2607 on `feat/inbox`). The build passes.
- Inline components inside `BookkeeperApp` remount on every parent render (see
  `ANALYSIS-BookKeeper.md` §1.4). New stateful pages must be module scope.
- `bk_inbox_items.division` is set by the runs from the matched job (or the
  mailbox); items whose job sits in another company are shown under
  "All companies" only.

## Next tasks (ideas, not committed)

- Inbox: "Mark paid" shortcut on `money` items that opens the invoice.
- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Runs: when a chase/reply draft is sent from Outlook, auto-mark the item done
  (needs the close-off run to check Sent Items against open items).
