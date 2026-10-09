-- Vault: an encrypted safe for business secrets (ASIC corporate key, ATO/myGovID
-- logins, bank portal passwords, insurance policy numbers, …).
--
-- Zero-knowledge by design. The browser encrypts everything with a random data
-- key (AES-256-GCM) before it reaches Supabase; that data key is itself wrapped
-- under a key derived (PBKDF2-SHA256, per-vault salt) from a passphrase that is
-- never sent anywhere. So these tables hold only salts, a wrapped key and
-- ciphertext. Nobody with database access can read the contents, and a lost
-- passphrase cannot be recovered — see src/lib/vault-crypto.mjs. Idempotent.

-- One vault per user per business ------------------------------------------
create table if not exists public.bk_vaults (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id text not null default 'mworx',
  kdf text not null default 'PBKDF2-SHA256',
  kdf_iterations integer not null,
  salt text not null,            -- base64, 16 random bytes
  wrapped_key text not null,     -- base64( iv || AES-GCM(data key) ) under the passphrase key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, business_id)
);

alter table public.bk_vaults enable row level security;

drop policy if exists bk_vaults_owner on public.bk_vaults;
create policy bk_vaults_owner on public.bk_vaults
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Items: one opaque ciphertext each ----------------------------------------
-- The plaintext is a JSON object {title, category, username, secret, url,
-- notes, fields[]} — including the title, so even the list of what is in the
-- safe stays private until it is unlocked in the browser.
create table if not exists public.bk_vault_items (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references public.bk_vaults(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ciphertext text not null,      -- base64( iv || AES-GCM(json) ) under the data key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bk_vault_items_vault_id_idx on public.bk_vault_items(vault_id);

alter table public.bk_vault_items enable row level security;

drop policy if exists bk_vault_items_owner on public.bk_vault_items;
create policy bk_vault_items_owner on public.bk_vault_items
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
