-- The Inbox follows the documents its rows point at (invoice_id), so Michel
-- never ticks these by hand and the runs never re-raise them (not 'open'):
--   quote    sent / accepted  → the proposal item is done
--   quote    declined         → the proposal item is dismissed
--   invoice  sent             → the money item is done ("still a draft" items)
--   invoice  paid             → the money item is done
--   invoice  superseded / cancelled → the money item is dismissed
-- Fires on status changes only. Runs as the updating user (the app's owner
-- RLS covers both tables; service-role callers bypass it). Re-runnable.

create or replace function public.bk_inbox_follow_invoice() returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_note   text;
  v_kind   text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.type = 'quote' then
    v_kind := 'proposal';
    if new.status in ('sent', 'accepted') then
      v_status := 'done';      v_note := 'Quote ' || coalesce(new.number, '') || ' ' || new.status;
    elsif new.status = 'declined' then
      v_status := 'dismissed'; v_note := 'Quote ' || coalesce(new.number, '') || ' declined';
    else
      return new;
    end if;
  else
    v_kind := 'money';
    if new.status in ('sent', 'paid') then
      v_status := 'done';      v_note := 'Invoice ' || coalesce(new.number, '') || ' ' || new.status;
    elsif new.status in ('superseded', 'cancelled') then
      v_status := 'dismissed'; v_note := 'Invoice ' || coalesce(new.number, '') || ' ' || new.status;
    else
      return new;
    end if;
  end if;

  -- Never let the Inbox fail an invoice: whatever goes wrong here is logged,
  -- the quote / invoice update itself always goes through.
  begin
    update bk_inbox_items
       set status = v_status, resolved_at = now(), resolved_note = v_note, updated_at = now()
     where invoice_id = new.id and status = 'open' and kind = v_kind;
  exception when others then
    raise warning 'bk_inbox_follow_invoice: % (invoice %)', sqlerrm, new.id;
  end;
  return new;
end
$$;

create or replace trigger bk_inbox_follow_invoice
  after update of status on public.bk_invoices
  for each row execute function public.bk_inbox_follow_invoice();
