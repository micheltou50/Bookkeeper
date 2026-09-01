-- Revision marker printed beside the quote details ("Revision 00").
-- Text, not an integer: practices number revisions "00"/"01" and occasionally
-- "A"/"B", and a leading zero has to survive a round trip.
-- Idempotent, per this project's convention.
alter table bk_invoices add column if not exists revision text;
