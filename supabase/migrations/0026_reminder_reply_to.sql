-- Where replies to automatic payment reminders land, per company. Separate
-- from bk_profiles.email (which prints on quotes and invoices) so reminders
-- can route to an accounts inbox without changing the letterhead. Blank =
-- fall back to the company email. Idempotent.
alter table public.bk_profiles
  add column if not exists reminder_reply_to text;

-- Mworx Group's reminders reply to the accounts inbox (user request, 2026-10-10).
update public.bk_profiles
   set reminder_reply_to = 'accounts@mworxgroup.com.au'
 where business_id = 'mworx'
   and reminder_reply_to is null;
