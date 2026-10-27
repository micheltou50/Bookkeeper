-- Fee proposals on Michel's behalf: turn a 'proposal' Inbox item into a draft
-- quote the way the app would — next quote number for the division, the quote
-- type (bk_quote_templates) for the job's application type with its scope,
-- notes and payment plan, the client linked or created, the job linked or
-- created as a lead — and point the item's invoice_id at it. Nothing is sent:
-- Michel opens the quote from the Inbox row, checks the price and sends.
--
-- Called by the scheduled runs (service role, via execute_sql) right after they
-- raise a proposal item, and by the Inbox page ("Draft quote", rpc as the
-- signed-in user — RLS applies, he owns every row).
--
-- Rules:
-- - An item that already has invoice_id returns it; a job that already has a
--   draft quote gets that one linked rather than a second draft.
-- - Quote type: p_template_id if given, else the only one for the application
--   type; with several or none the quote gets one scope line and the note
--   says so.
-- - Price: p_amount (the run's suggestion from comparable quotes), else the
--   quote type's lump amount, else 0 ("price it").
-- - [address] in scope lines becomes the job address; [proposed works],
--   [description], [proposed use] and [structure / use] become p_works when
--   given. Other [brackets] stay for Michel, as in the app.
-- - Terms: copied from the last quote in the division (the app's default
--   terms live in the front end).
-- Re-runnable (create or replace).

create or replace function public.bk_draft_quote_from_proposal(
  p_item_id uuid,
  p_application_type text default null,
  p_works text default null,
  p_amount numeric default null,
  p_template_id uuid default null,
  p_client_company text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item     bk_inbox_items%rowtype;
  v_job      bk_jobs%rowtype;
  v_contact  bk_contacts%rowtype;
  v_tpl      bk_quote_templates%rowtype;
  v_existing bk_invoices%rowtype;
  v_now_syd  timestamp := (now() at time zone 'Australia/Sydney');
  v_today    date;
  v_yy       text;
  v_div      text;
  v_app_type text;
  v_works    text := nullif(trim(coalesce(p_works, '')), '');
  v_company  text := nullif(trim(coalesce(p_client_company, '')), '');
  v_email    text;
  v_name     text;
  v_address  text;
  v_prefix   text;
  v_tag      text;
  v_seq      bigint;
  v_number   text;
  v_terms    text;
  v_total    numeric := 0;
  v_quote_id uuid;
  v_job_created     boolean := false;
  v_contact_created boolean := false;
  v_tpl_count int := 0;
  v_note     text := '';
  v_i        int := 0;
  v_it       jsonb;
  v_desc     text;
  v_qty      numeric;
  v_rate     numeric;
  v_s        text;
begin
  v_today := v_now_syd::date;
  v_yy := to_char(v_now_syd, 'YY');

  select * into v_item from bk_inbox_items where id = p_item_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'inbox item not found');
  end if;
  if v_item.kind <> 'proposal' then
    return jsonb_build_object('ok', false, 'error', 'not a proposal item (kind ' || v_item.kind || ')');
  end if;
  if v_item.invoice_id is not null then
    select * into v_existing from bk_invoices where id = v_item.invoice_id;
    return jsonb_build_object('ok', true, 'quote_id', v_item.invoice_id, 'quote_number', v_existing.number,
                              'job_id', v_item.job_id, 'note', 'already drafted');
  end if;

  v_div := coalesce(nullif(v_item.division, ''), 'mworx');
  v_app_type := nullif(trim(coalesce(p_application_type, '')), '');
  v_email := nullif(lower(trim(coalesce(v_item.sender_email, ''))), '');
  v_name := nullif(trim(coalesce(v_item.sender_name, '')), '');
  v_address := nullif(regexp_replace(trim(coalesce(v_item.job_address, '')), '\s+', ' ', 'g'), '');

  -- Client: by email, then by name; else a new client contact.
  if v_email is not null then
    select * into v_contact from bk_contacts
      where business_id = v_item.business_id and lower(coalesce(email, '')) = v_email
      order by created_at limit 1;
  end if;
  if v_contact.id is null and v_name is not null then
    select * into v_contact from bk_contacts
      where business_id = v_item.business_id and lower(name) = lower(v_name)
      order by created_at limit 1;
  end if;
  if v_contact.id is null and (v_name is not null or v_email is not null) then
    insert into bk_contacts (user_id, business_id, name, email, type, company)
      values (v_item.user_id, v_item.business_id, coalesce(v_name, v_email),
              nullif(trim(coalesce(v_item.sender_email, '')), ''), 'client', v_company)
      returning * into v_contact;
    v_contact_created := true;
  end if;

  -- Job: the item's, else the one at that address, else a new lead.
  if v_item.job_id is not null then
    select * into v_job from bk_jobs where id = v_item.job_id;
  end if;
  if v_job.id is null and v_address is not null then
    select * into v_job from bk_jobs
      where business_id = v_item.business_id
        and lower(regexp_replace(coalesce(address, ''), '\s+', ' ', 'g')) = lower(v_address)
      order by created_at desc limit 1;
  end if;
  if v_job.id is null then
    if v_address is null then
      return jsonb_build_object('ok', false, 'error', 'no job and no address on the item');
    end if;
    -- Job numbers, as getNextJobNumber in the app: Mworx Energy has its own
    -- sequence, YY1### from YY1001 (261001 …, matching its OneDrive folders);
    -- the other companies share YY### from YY101 (26101 …).
    if v_div = 'mworx_energy' then
      select coalesce(max(job_number::bigint), (v_yy || '1000')::bigint) + 1 into v_seq
        from bk_jobs
        where business_id = v_item.business_id and division = 'mworx_energy'
          and job_number ~ '^\d{6}$' and job_number like v_yy || '%';
    else
      select coalesce(max(job_number::bigint), (v_yy || '100')::bigint) + 1 into v_seq
        from bk_jobs
        where business_id = v_item.business_id and division <> 'mworx_energy'
          and job_number ~ '^\d{5}$' and job_number like v_yy || '%';
    end if;
    insert into bk_jobs (user_id, business_id, division, name, address, status, application_type, job_number, contact_id, contract_value)
      values (v_item.user_id, v_item.business_id, v_div,
              left(coalesce(v_app_type || ' - ', '') || coalesce(v_works, 'Enquiry'), 80),
              v_address, 'lead', v_app_type, v_seq::text, v_contact.id, 0)
      returning * into v_job;
    v_job_created := true;
  else
    if v_job.application_type is null and v_app_type is not null then
      update bk_jobs set application_type = v_app_type where id = v_job.id;
      v_job.application_type := v_app_type;
    end if;
    if v_job.contact_id is null and v_contact.id is not null then
      update bk_jobs set contact_id = v_contact.id where id = v_job.id;
      v_job.contact_id := v_contact.id;
    end if;
  end if;
  v_app_type := coalesce(v_job.application_type, v_app_type);
  v_div := coalesce(nullif(v_job.division, ''), v_div);

  -- A draft already on this job wins over a second one.
  select * into v_existing from bk_invoices
    where project_id = v_job.id and type = 'quote' and status = 'draft'
    order by created_at desc limit 1;
  if v_existing.id is not null then
    update bk_inbox_items
      set invoice_id = v_existing.id, job_id = v_job.id, updated_at = now(),
          detail = left(coalesce(detail || E'\n', '') || 'Linked to draft ' || coalesce(v_existing.number, 'quote') || ' already on this job.', 2000)
      where id = v_item.id;
    return jsonb_build_object('ok', true, 'quote_id', v_existing.id, 'quote_number', v_existing.number,
                              'job_id', v_job.id, 'job_number', v_job.job_number, 'job_created', v_job_created,
                              'contact_id', v_contact.id, 'contact_created', v_contact_created, 'note', 'linked existing draft');
  end if;

  -- Quote type: the one asked for, else the only one for the application type.
  if p_template_id is not null then
    select * into v_tpl from bk_quote_templates where id = p_template_id and business_id = v_item.business_id;
    if v_tpl.id is null then
      return jsonb_build_object('ok', false, 'error', 'quote type not found');
    end if;
  elsif v_app_type is not null then
    select count(*) into v_tpl_count from bk_quote_templates
      where business_id = v_item.business_id and application_type = v_app_type;
    if v_tpl_count = 1 then
      select * into v_tpl from bk_quote_templates
        where business_id = v_item.business_id and application_type = v_app_type;
    elsif v_tpl_count > 1 then
      v_note := v_tpl_count || ' quote types match ' || v_app_type || ' — pick one in the quote';
    else
      v_note := 'no quote type for ' || v_app_type || ' — scope to fill in';
    end if;
  else
    v_note := 'no application type — scope to fill in';
  end if;

  -- Number: <quote prefix><YY><seq>, per division, like getNextDocumentNumber.
  select quote_prefix into v_prefix from bk_profiles
    where business_id = v_div and nullif(trim(coalesce(quote_prefix, '')), '') is not null
    limit 1;
  v_prefix := coalesce(v_prefix, case v_div when 'mworx_energy' then 'QME' when 'mt_management' then 'QMTM' else 'QMWX' end);
  v_tag := v_prefix || v_yy;
  select coalesce(max(substr(number, length(v_tag) + 1)::bigint), 0) + 1 into v_seq
    from bk_invoices
    where business_id = v_item.business_id and division = v_div and type = 'quote'
      and number like v_tag || '%' and substr(number, length(v_tag) + 1) ~ '^\d+$';
  v_number := v_tag || lpad(v_seq::text, 3, '0');

  -- Terms: what the last quote in this division carried.
  select terms into v_terms from bk_invoices
    where business_id = v_item.business_id and division = v_div and type = 'quote' and nullif(terms, '') is not null
    order by created_at desc limit 1;

  if coalesce(v_tpl.pricing_mode, 'lump_sum') = 'lump_sum' then
    v_total := coalesce(p_amount, v_tpl.lump_amount, 0);
  end if;

  insert into bk_invoices (user_id, business_id, number, type, date, due_date,
                           contact_id, contact_name, contact_email, contact_company, contact_abn, contact_address, contact_phone,
                           job, notes, status, total, project_id, pricing_mode, terms, division, payment_plan)
    values (v_item.user_id, v_item.business_id, v_number, 'quote', v_today, v_today + 30,
            v_contact.id, coalesce(v_contact.name, v_name, ''), coalesce(v_contact.email, v_item.sender_email, ''),
            coalesce(v_company, v_contact.company, ''), coalesce(v_contact.abn, ''), coalesce(v_contact.address, ''), coalesce(v_contact.phone, ''),
            coalesce(v_job.address, ''), v_tpl.notes, 'draft', v_total, v_job.id,
            coalesce(v_tpl.pricing_mode, 'lump_sum'), v_terms, v_div, v_tpl.payment_plan)
    returning id into v_quote_id;

  -- Scope lines from the quote type, placeholders filled where we can.
  if v_tpl.id is not null and jsonb_typeof(v_tpl.items) = 'array' and jsonb_array_length(v_tpl.items) > 0 then
    for v_it in select value from jsonb_array_elements(v_tpl.items) loop
      v_desc := replace(coalesce(v_it->>'description', ''), '[address]', coalesce(v_job.address, '[address]'));
      if v_works is not null then
        v_desc := replace(replace(replace(replace(v_desc, '[proposed works]', v_works), '[description]', v_works), '[proposed use]', v_works), '[structure / use]', v_works);
      end if;
      v_s := trim(coalesce(v_it->>'qty', ''));
      v_qty := case when v_s ~ '^-?\d+(\.\d+)?$' then v_s::numeric else 1 end;
      v_s := trim(coalesce(v_it->>'rate', ''));
      v_rate := case when v_s ~ '^-?\d+(\.\d+)?$' then v_s::numeric else 0 end;
      insert into bk_invoice_items (invoice_id, description, note, qty, rate, sort_order)
        values (v_quote_id, v_desc, coalesce(v_it->>'note', ''), v_qty, v_rate, v_i);
      v_i := v_i + 1;
    end loop;
  else
    insert into bk_invoice_items (invoice_id, description, note, qty, rate, sort_order)
      values (v_quote_id,
              coalesce(v_app_type, 'Fee proposal') || ' for ' || coalesce(v_works, '[proposed works]') || ' at ' || coalesce(v_job.address, '[address]'),
              '', 1, 0, 0);
  end if;
  if coalesce(v_tpl.pricing_mode, 'lump_sum') <> 'lump_sum' then
    update bk_invoices
      set total = (select coalesce(sum(qty * rate), 0) from bk_invoice_items where invoice_id = v_quote_id)
      where id = v_quote_id
      returning total into v_total;
  end if;

  update bk_inbox_items
    set invoice_id = v_quote_id, job_id = v_job.id, updated_at = now(),
        detail = left(coalesce(detail || E'\n', '')
                      || 'Draft ' || v_number || ' ready'
                      || case when v_total > 0 then ' at $' || to_char(v_total, 'FM999,999,990') || ' (suggested — check it)' else ' — price it' end
                      || case when v_tpl.id is not null then ' · ' || v_tpl.name else '' end
                      || case when v_note <> '' then ' · ' || v_note else '' end
                      || case when v_job_created then ' · new lead ' || coalesce(v_job.job_number, '') else '' end, 2000)
    where id = v_item.id;

  return jsonb_build_object('ok', true, 'quote_id', v_quote_id, 'quote_number', v_number, 'amount', v_total,
                            'job_id', v_job.id, 'job_number', v_job.job_number, 'job_created', v_job_created,
                            'contact_id', v_contact.id, 'contact_created', v_contact_created,
                            'template', v_tpl.name, 'note', nullif(v_note, ''));
end
$$;

revoke all on function public.bk_draft_quote_from_proposal(uuid, text, text, numeric, uuid, text) from public;
grant execute on function public.bk_draft_quote_from_proposal(uuid, text, text, numeric, uuid, text) to authenticated, service_role;
