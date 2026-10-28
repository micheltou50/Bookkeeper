-- Inbox quality pass (28 Oct 2026): what a run did has to be checked, not
-- assumed.
--
--   * bk_inbox_items.file_link — the OneDrive webUrl of a filed (or unplaced)
--     file, so an item opens the document in one click, next to draft_link and
--     email_link.
--   * bk_inbox_runs.qa — the run's own verification list: one entry per action
--     (draft, file, folder, quote, items, done) with result 'completed' /
--     'partial' / 'failed' and the evidence read back. bk_inbox_run_qa() stores
--     it as the run's last write, adds what the database can check itself, and
--     moves the run to 'partial' when anything is not completed, so a run can
--     never report clean over a failed action.
--   * bk_inbox_write_items: a link key passed as JSON null now clears the link
--     (a draft the run deleted); a key left out, or empty, keeps what is there
--     (unchanged behaviour); file_path and file_link follow the same rule.
-- Additive and re-runnable; no drops.

alter table public.bk_inbox_items add column if not exists file_link text;
alter table public.bk_inbox_runs add column if not exists qa jsonb not null default '[]'::jsonb;

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
                                    due_date, promised_at, email_id, email_link, conversation_id, draft_id, draft_link, file_path, file_link, invoice_id,
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
                nullif(v_it->>'file_link', ''),
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
              -- a link passed as JSON null clears; passed non-empty replaces; left out or empty keeps
              draft_id    = case when jsonb_typeof(v_it->'draft_id') = 'null' then null else coalesce(excluded.draft_id, bk_inbox_items.draft_id) end,
              draft_link  = case when jsonb_typeof(v_it->'draft_link') = 'null' then null else coalesce(excluded.draft_link, bk_inbox_items.draft_link) end,
              email_link  = case when jsonb_typeof(v_it->'email_link') = 'null' then null else coalesce(excluded.email_link, bk_inbox_items.email_link) end,
              file_path   = case when jsonb_typeof(v_it->'file_path') = 'null' then null else coalesce(excluded.file_path, bk_inbox_items.file_path) end,
              file_link   = case when jsonb_typeof(v_it->'file_link') = 'null' then null else coalesce(excluded.file_link, bk_inbox_items.file_link) end,
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

-- The run's last write: its verification list, plus what the database can see
-- for itself. Any entry that is not 'completed' moves an 'ok' run to 'partial'.
create or replace function public.bk_inbox_run_qa(p_run_id uuid, p_qa jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_run     bk_inbox_runs%rowtype;
  v_qa      jsonb := coalesce(p_qa, '[]'::jsonb);
  v_auto    jsonb := '[]'::jsonb;
  v_done    int := 0;
  v_partial int := 0;
  v_failed  int := 0;
  v_status  text;
  r         record;
begin
  select * into v_run from bk_inbox_runs where id = p_run_id;
  if v_run.id is null then
    return jsonb_build_object('ok', false, 'error', 'run not found');
  end if;
  if jsonb_typeof(v_qa) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'p_qa must be a JSON array');
  end if;
  for r in select kind, title, draft_id, draft_link, invoice_id, file_link
             from bk_inbox_items where run_id = p_run_id and status = 'open' loop
    if r.kind = 'proposal' and r.invoice_id is null then
      v_auto := v_auto || jsonb_build_object('action', 'quote', 'ref', r.title, 'result', 'partial', 'evidence', 'proposal item has no draft quote', 'auto', true);
    end if;
    if r.draft_id is not null and r.draft_link is null then
      v_auto := v_auto || jsonb_build_object('action', 'draft', 'ref', r.title, 'result', 'partial', 'evidence', 'draft_id set but no draft_link', 'auto', true);
    end if;
    if r.kind = 'file' and r.file_link is null then
      v_auto := v_auto || jsonb_build_object('action', 'file', 'ref', r.title, 'result', 'partial', 'evidence', 'filed item has no file_link', 'auto', true);
    end if;
  end loop;
  v_qa := v_qa || v_auto;
  select count(*) filter (where e->>'result' = 'completed'),
         count(*) filter (where e->>'result' = 'partial'),
         count(*) filter (where e->>'result' = 'failed')
    into v_done, v_partial, v_failed
    from jsonb_array_elements(v_qa) e;
  v_status := v_run.status;
  if v_status = 'ok' and (v_failed > 0 or v_partial > 0) then
    v_status := 'partial';
  end if;
  update bk_inbox_runs set qa = v_qa, status = v_status where id = p_run_id;
  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'status', v_status, 'completed', v_done, 'partial', v_partial, 'failed', v_failed, 'auto_findings', v_auto);
end $$;

revoke all on function public.bk_inbox_run_qa(uuid, jsonb) from public;
grant execute on function public.bk_inbox_run_qa(uuid, jsonb) to authenticated, service_role;
