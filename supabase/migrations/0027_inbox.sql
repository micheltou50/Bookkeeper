-- Inbox: the action list the scheduled email runs (Claude "Mworx morning inbox"
-- at ~7:12am and "Mworx close-off" at ~4:15pm Sydney) write into, and the Inbox
-- page in the app reads. One row per thing Michel has to act on — a reply to
-- send, a consultant to chase, a Council deadline, a payment to record, a file
-- the run couldn't place — plus one row per filed attachment for the record.
--
-- The runs upsert on dedupe_key so the same email never produces two rows, and
-- they skip anything already done or dismissed, so ticking an item off in the
-- app is what stops it coming back. Rows are written by the runs (service
-- role, user_id set explicitly) and read/updated by the browser (RLS: owner).
-- Idempotent.

create table if not exists public.bk_inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id text not null default 'mworx',
  division text not null default 'mworx',          -- company slug: mworx · mworx_energy · mt_management
  job_id uuid references public.bk_jobs(id) on delete set null,
  job_address text,                                 -- free text when no bk_jobs row matched
  kind text not null check (kind in ('reply','chase','deadline','money','call','file','skipped','fyi')),
  title text not null,
  detail text,
  mailbox text check (mailbox in ('info','accounts','energy')),
  sender_name text,
  sender_email text,
  due_date date,
  promised_at date,                                 -- the Sydney date a promise/request was made
  email_id text,                                    -- Outlook message id the item came from
  email_link text,                                  -- Outlook webLink to open it
  conversation_id text,
  draft_id text,                                    -- Outlook draft the run prepared (reply / chase)
  draft_link text,
  file_path text,                                   -- OneDrive path for filed / skipped / unplaced files
  invoice_id uuid references public.bk_invoices(id) on delete set null,
  status text not null default 'open' check (status in ('open','done','dismissed')),
  resolved_at timestamptz,
  resolved_note text,
  dedupe_key text not null,                         -- e.g. reply:<internetMessageId>, chase:<conversationId>:<promised_at>
  source_run text,                                  -- morning · closeoff · manual
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create index if not exists bk_inbox_items_open_idx on public.bk_inbox_items(user_id, status, created_at desc);
create index if not exists bk_inbox_items_job_idx on public.bk_inbox_items(job_id);

alter table public.bk_inbox_items enable row level security;

drop policy if exists bk_inbox_items_owner on public.bk_inbox_items;
create policy bk_inbox_items_owner on public.bk_inbox_items
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- One row per scheduled run: when it ran, what it found, and the short digest
-- the app shows as "Last run". A failed run writes status 'error' so a silent
-- morning is never mistaken for a quiet one.
create table if not exists public.bk_inbox_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id text not null default 'mworx',
  run_type text not null check (run_type in ('morning','closeoff','manual')),
  ran_at timestamptz not null default now(),
  sydney_date date not null,
  status text not null default 'ok' check (status in ('ok','partial','error')),
  summary text,                                     -- bottom line, a few lines, markdown
  counts jsonb not null default '{}'::jsonb,        -- {"reply":2,"chase":1,"file":4,...}
  error text,
  created_at timestamptz not null default now()
);

create index if not exists bk_inbox_runs_recent_idx on public.bk_inbox_runs(user_id, ran_at desc);

alter table public.bk_inbox_runs enable row level security;

drop policy if exists bk_inbox_runs_owner on public.bk_inbox_runs;
create policy bk_inbox_runs_owner on public.bk_inbox_runs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
