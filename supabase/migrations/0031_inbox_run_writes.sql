-- The writes the scheduled runs make, as functions called with SELECT.
--
-- The Supabase connector asks the user to confirm any statement that looks
-- like an UPDATE / DELETE / DROP, and a scheduled run has nobody to answer:
-- the 27 Oct close-off stalled on exactly that (its item upsert carried
-- "on conflict do update" and was followed by the run update) and wrote
-- nothing. A SELECT that calls a function is not questioned, so the runs now
-- do all their writing through these four. Same rules as before:
--   - items upsert on (user_id, dedupe_key); a row that is done or dismissed
--     is never touched again; a refresh keeps focus, and keeps the draft /
--     email / job / invoice links unless the new row carries one;
--   - one bad item does not sink the batch: it is reported in `errors`.
-- The app can call them too (owner RLS applies under rpc). Re-runnable.

create or replace function public.bk_inbox_open_run(p_user_id uuid, p_run_type text, p_sydney_date date)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  insert into bk_inbox_runs (user_id, business_id, run_type, sydney_date, status)
  values (p_user_id, 'mworx', p_run_type, p_sydney_date, 'ok')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.bk_inbox_close_run(p_run_id uuid, p_status text, p_summary text, p_counts jsonb default '{}'::jsonb, p_error text default null)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare v_row bk_inbox_runs%rowtype;
begin
  update bk_inbox_runs
     set status = coalesce(nullif(p_status, ''), status), summary = p_summary, counts = coalesce(p_counts, '{}'::jsonb), error = p_error
   where id = p_run_id
   returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'run not found');
  end if;
  return jsonb_build_object('ok', true, 'run_id', v_row.id, 'status', v_row.status, 'counts', v_row.counts);
end $$;

create or replace function public.bk_inbox_mark_done(p_item_id uuid, p_note text default null)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare v_prev text;
begin
  select status into v_prev from bk_inbox_items where id = p_item_id;
  if v_prev is null then
    return jsonb_build_object('ok', false, 'error', 'item not found');
  end if;
  if v_prev <> 'open' then
    return jsonb_build_object('ok', true, 'changed', false, 'status', v_prev);
  end if;
  update bk_inbox_items
     set status = 'done', resolved_at = now(), resolved_note = p_note, updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'changed', true, 'status', 'done');
end $$;

create or replace function public.bk_inbox_write_items(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_it     jsonb;
  v_n      int := 0;
  v_ins    int := 0;
  v_ref    int := 0;
  v_skip   int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_prev   text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'p_items must be a JSON array of items');
  end if;
  for v_it in select value from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    begin
      if coalesce(v_it->>'dedupe_key', '') = '' or coalesce(v_it->>'kind', '') = '' or coalesce(v_it->>'title', '') = '' then
        raise exception 'kind, title and dedupe_key are required';
      end if;
      select status into v_prev from bk_inbox_items where user_id = p_user_id and dedupe_key = v_it->>'dedupe_key';
      if v_prev is not null and v_prev <> 'open' then
        v_skip := v_skip + 1;
      else
        insert into bk_inbox_items (user_id, business_id, division, job_id, job_address, kind, title, detail, mailbox, sender_name, sender_email,
                                    due_date, promised_at, email_id, email_link, conversation_id, draft_id, draft_link, file_path, invoice_id,
                                    dedupe_key, source_run, run_id, focus)
        values (p_user_id,
                coalesce(nullif(v_it->>'business_id', ''), 'mworx'),
                coalesce(nullif(v_it->>'division', ''), 'mworx'),
                nullif(v_it->>'job_id', '')::uuid,
                nullif(v_it->>'job_address', ''),
                v_it->>'kind',
                v_it->>'title',
                nullif(v_it->>'detail', ''),
                nullif(v_it->>'mailbox', ''),
                nullif(v_it->>'sender_name', ''),
                nullif(v_it->>'sender_email', ''),
                nullif(v_it->>'due_date', '')::date,
                nullif(v_it->>'promised_at', '')::date,
                nullif(v_it->>'email_id', ''),
                nullif(v_it->>'email_link', ''),
                nullif(v_it->>'conversation_id', ''),
                nullif(v_it->>'draft_id', ''),
                nullif(v_it->>'draft_link', ''),
                nullif(v_it->>'file_path', ''),
                nullif(v_it->>'invoice_id', '')::uuid,
                v_it->>'dedupe_key',
                nullif(v_it->>'source_run', ''),
                nullif(v_it->>'run_id', '')::uuid,
                nullif(v_it->>'focus', '')::boolean)
        on conflict (user_id, dedupe_key) do update
          set title       = excluded.title,
              detail      = excluded.detail,
              due_date    = excluded.due_date,
              promised_at = excluded.promised_at,
              draft_id    = coalesce(excluded.draft_id, bk_inbox_items.draft_id),
              draft_link  = coalesce(excluded.draft_link, bk_inbox_items.draft_link),
              email_link  = coalesce(excluded.email_link, bk_inbox_items.email_link),
              job_id      = coalesce(excluded.job_id, bk_inbox_items.job_id),
              invoice_id  = coalesce(excluded.invoice_id, bk_inbox_items.invoice_id),
              run_id      = excluded.run_id,
              updated_at  = now()
          where bk_inbox_items.status = 'open';
        if v_prev is null then v_ins := v_ins + 1; else v_ref := v_ref + 1; end if;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object('item', v_n, 'dedupe_key', v_it->>'dedupe_key', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(v_errors) = 0, 'inserted', v_ins, 'refreshed', v_ref, 'skipped_closed', v_skip, 'errors', v_errors);
end $$;

revoke all on function public.bk_inbox_open_run(uuid, text, date) from public;
revoke all on function public.bk_inbox_close_run(uuid, text, text, jsonb, text) from public;
revoke all on function public.bk_inbox_mark_done(uuid, text) from public;
revoke all on function public.bk_inbox_write_items(uuid, jsonb) from public;
grant execute on function public.bk_inbox_open_run(uuid, text, date) to authenticated, service_role;
grant execute on function public.bk_inbox_close_run(uuid, text, text, jsonb, text) to authenticated, service_role;
grant execute on function public.bk_inbox_mark_done(uuid, text) to authenticated, service_role;
grant execute on function public.bk_inbox_write_items(uuid, jsonb) to authenticated, service_role;
