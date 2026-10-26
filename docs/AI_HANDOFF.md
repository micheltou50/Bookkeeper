# BookKeeper — AI handoff

Current state, work in progress, known bugs and next tasks. Rewrite the
sections rather than appending forever. Last updated: 2026-10-27 (Sydney).

## Status

- `main` = PR #27 (reminder reply-to) merged.
- Branch `feat/inbox` (PR #29, open) adds the Inbox feature: migration
  `0027_inbox.sql` (applied live 27 Oct), `InboxPage`, nav badge, dashboard
  rows, these docs — and, on top, **Focus**: migration `0028_inbox_focus.sql`,
  the Focus card and pill, "Add a task", kinds `proposal` and `task`, badge and
  dashboard / mobile rows now counting Focus, "Open invoice / quote" on rows
  that carry an `invoice_id`.

## In progress — Inbox

- [x] `0027_inbox.sql` applied to the live project; the first run has written rows.
- [ ] Apply `supabase/migrations/0028_inbox_focus.sql` (additive: `focus`
      column + wider `kind` check). Until then the page still works — Focus
      runs on the auto rules only — but pinning and "Add a task" show a
      "needs migration 0028" notice.
- [ ] Merge `feat/inbox` so Netlify deploys the page.
- [ ] Teach the two scheduled runs ("Mworx morning inbox", "Mworx close-off")
      to set `focus = true` on urgent items and to raise `proposal` items for
      fee / quote requests — AFTER 0028 is live (an insert naming `focus`
      before that fails the whole write). See "Runs — Focus and proposals".
- [ ] Check that ticking Done stops an item being re-raised next run.

## Runs — Focus and proposals (to add to both run prompts, after 0028)

- Add `focus` to the insert column list: `true` for every chase, a reply
  waiting more than 2 business days, a deadline today or tomorrow, a payment
  received or an invoice overdue, and anything the run would lead the
  PushNotification with; otherwise `null` (never `false` — that is Michel's).
  Leave `focus` out of the `on conflict ... do update set` list so his pins and
  removals survive.
- New kind `proposal`: an email asking for a fee / quote / proposal (a new
  enquiry, or an existing client asking to price more work). Key
  `proposal:<internetMessageId>`. Title "Fee proposal — <address> (<who>)";
  detail = what they want, the application type if stated, what they attached.
  Still draft a holding reply ("Thanks — we'll have a fee proposal to you by
  [day]") under the JOB 2 rules. Count it in `counts` as `"proposal"`.

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

## Next — fee proposals on Michel's behalf (plan, not started)

Goal: a quote request lands → Bookkeeper ends up holding a draft quote that
Michel only has to check and send. Pieces, in order:

1. The runs raise `proposal` items (above): detection and a holding reply, no
   quote yet.
2. A Netlify function (service role), e.g. `create-quote-from-template`: given
   a `proposal` item id it picks the job (or creates a `lead` in `bk_jobs` from
   the address and the client contact), picks the `bk_quote_templates` row for
   the job's `application_type` (lump-sum amount, `pricing_mode`, `items`,
   `payment_plan`, `terms`), inserts the quote (`bk_invoices`, `type='quote'`,
   next quote number via the app's numbering) and writes the quote id back to
   the item's `invoice_id`. The run calls this instead of writing `bk_invoices`
   itself, so its hard rule "only touch the inbox tables" stands.
3. The Inbox row then shows "Open quote QXXX"; Michel checks the price and
   sends from the quote modal (the existing `send-invoice-outlook` flow).
   Nothing goes to a client without him.

Open questions for Michel: which application types carry a fixed fee in their
template (those can be drafted end to end; the rest get the proposal item and
holding reply only); whether the run may create `lead` jobs and client
contacts; whether to attach the quote PDF to the holding-reply draft.

## Next tasks (ideas, not committed)

- Inbox: "Mark paid" shortcut on `money` items (the row already opens the invoice).
- Inbox: per-job view (list a project's open items inside the project modal).
- Inbox: snooze (hide until a date) for deadlines.
- Runs: when a chase/reply draft is sent from Outlook, auto-mark the item done
  (needs the close-off run to check Sent Items against open items).
