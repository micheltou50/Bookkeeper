-- Inbox focus: the short list on top of the long record. The runs' list only
-- grows (filed, skipped, FYI, things that can't be cleared), so Focus is what
-- Michel is actually doing today. `focus` is three-valued:
--   true  — pinned: by Michel in the app, or by a run that judged it urgent
--   false — taken out of Focus by Michel; stays out even while overdue
--   null  — undecided: the app shows it in Focus while it's open and a chase,
--           a fee proposal, a hand-added task, or due today / overdue
-- The runs' upsert never sets the column, so a pin or a removal survives a
-- refresh of the same dedupe_key.
--
-- Also widens kind with 'proposal' (a fee proposal to price and send — raised
-- by the runs from quote requests; invoice_id will point at the draft quote
-- once the runs prepare one) and 'task' (typed in by hand on the Inbox page,
-- dedupe_key 'task:<uuid>', source_run 'manual').
-- Additive and re-runnable.

alter table public.bk_inbox_items add column if not exists focus boolean;

alter table public.bk_inbox_items drop constraint if exists bk_inbox_items_kind_check;
alter table public.bk_inbox_items add constraint bk_inbox_items_kind_check
  check (kind in ('reply','chase','proposal','deadline','money','call','task','file','skipped','fyi'));
