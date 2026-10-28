-- Keys for the Bookkeeper Inbox API (netlify/functions/inbox-api.mjs), the one
-- door the scheduled Inbox runs use to write: Outlook drafts and the Inbox
-- rows. The runs no longer write to the database themselves; they present a
-- bearer key, and the function calls the restricted bk_inbox_* functions with
-- the service role on their behalf.
--
-- The key itself is never stored here: only its sha256. The key lives in
-- Supabase Vault as 'inbox_api_key', where a run reads it at the start:
--   select decrypted_secret from vault.decrypted_secrets where name = 'inbox_api_key';
-- bk_inbox_api_key_issue() makes a new key (revoking the old), stores the hash
-- here and the key in Vault, and shows nothing — so issuing or rotating a key
-- never prints it. Call it as the project owner (SQL editor / connector):
--   select bk_inbox_api_key_issue('<user uuid>', 'scheduled runs');
-- Additive and re-runnable.

create table if not exists public.bk_inbox_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key_hash text not null unique,                    -- sha256 hex of the bearer key
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- No policies on purpose: the browser (anon / authenticated) can never read or
-- write keys. Only the service role, which bypasses RLS, used by inbox-api.
alter table public.bk_inbox_api_keys enable row level security;
revoke all on public.bk_inbox_api_keys from anon, authenticated;

create or replace function public.bk_inbox_api_key_issue(p_user_id uuid, p_label text default 'scheduled runs')
returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_key text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id  uuid;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'no such user';
  end if;
  update public.bk_inbox_api_keys set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  insert into public.bk_inbox_api_keys (user_id, key_hash, label)
  values (p_user_id, encode(extensions.digest(v_key, 'sha256'), 'hex'), p_label);
  select id into v_id from vault.secrets where name = 'inbox_api_key';
  if v_id is null then
    perform vault.create_secret(v_key, 'inbox_api_key', 'Bearer key the scheduled Inbox runs present to the Bookkeeper inbox-api function');
  else
    perform vault.update_secret(v_id, v_key);
  end if;
end $$;

revoke all on function public.bk_inbox_api_key_issue(uuid, text) from public, anon, authenticated;
