-- Fee proposals never adopt a fee from a quote type (28 Oct 2026). NOT APPLIED —
-- needs Michel's approval. Re-creates bk_draft_quote_from_proposal from 0034
-- with one change: a run-made draft quote always starts with total 0, whatever
-- the quote type's lump_amount or line rates (0034 used the lump amount for
-- non-BASIX types; no type carries one today, so nothing changes until a lump
-- amount is saved on a quote type — and then it still will not reach a
-- run-made draft). Everything else — client, lead job via bk_next_job_number,
-- numbering, scope lines, terms, the item link — is unchanged. Re-runnable;
-- no drops.

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
  v_jobnum   text;
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
  v_jobname  text;
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
    v_jobnum := bk_next_job_number(v_item.business_id, v_div);
    v_seq := v_jobnum::bigint;
    -- Job names are unique per business (idx_bk_jobs_unique_name): fall back
    -- to the address, then the number, until the name is free.
    v_jobname := left(coalesce(v_app_type || ' - ', '') || coalesce(v_works, 'Enquiry'), 80);
    if exists (select 1 from bk_jobs where user_id = v_item.user_id and business_id = v_item.business_id and lower(trim(name)) = lower(trim(v_jobname))) then
      v_jobname := left(v_jobname || ' — ' || v_address, 140);
    end if;
    if exists (select 1 from bk_jobs where user_id = v_item.user_id and business_id = v_item.business_id and lower(trim(name)) = lower(trim(v_jobname))) then
      v_jobname := left(v_jobname || ' (' || v_jobnum || ')', 160);
    end if;
    insert into bk_jobs (user_id, business_id, division, name, address, status, application_type, job_number, contact_id, contract_value)
      values (v_item.user_id, v_item.business_id, v_div, v_jobname,
              v_address, 'lead', v_app_type, v_jobnum, v_contact.id, 0)
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

  -- (A draft already on this job is no longer linked: each enquiry gets its own.)

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

  -- No fee is ever assumed: a run-made draft starts at 0 ("price it") whatever
  -- the quote type's lump_amount says, so no proposal — BASIX or design — can
  -- carry a fee Michel has not approved. p_amount is ignored. (0034 still let a
  -- quote type's lump_amount through for non-BASIX work; no type has one today.)
  v_total := 0;

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
  -- (An itemised quote type's rates are copied onto the lines for Michel to
  -- see, but the draft's total stays 0 until he prices it in the app.)

  update bk_inbox_items
    set invoice_id = v_quote_id, job_id = v_job.id, updated_at = now(),
        detail = left(coalesce(detail || E'\n', '')
                      || 'Draft ' || v_number || ' ready'
                      || ' — scope and fee to finish'
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
