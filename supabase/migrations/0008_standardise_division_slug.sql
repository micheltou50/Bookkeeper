-- Standardise MT Management division slug: mtmgmt → mt_management
-- Safe to run after 0007_divisions.sql. Idempotent for rows already using mt_management.

update public.bk_transactions set division = 'mt_management' where division = 'mtmgmt';
update public.bk_invoices set division = 'mt_management' where division = 'mtmgmt';
update public.bk_jobs set division = 'mt_management' where division = 'mtmgmt';
