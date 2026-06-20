-- Unique per-business job/project number (e.g. JOB-001) for bk_jobs.
-- Adds the column, backfills existing rows in creation order per business, and
-- enforces uniqueness per business. Additive + idempotent.

alter table public.bk_jobs add column if not exists job_number text;

-- Backfill any rows that don't have a number yet, numbered per business in
-- creation order. Re-runnable: only touches rows where job_number is null.
with numbered as (
  select id,
         'JOB-' || lpad((row_number() over (partition by business_id order by created_at nulls last, id))::text, 3, '0') as jn
  from public.bk_jobs
  where job_number is null
)
update public.bk_jobs j
   set job_number = n.jn
  from numbered n
 where j.id = n.id;

-- Uniqueness per business (the client also generates max+1 per business; this is
-- the safety net). Partial so legacy nulls never block the index.
create unique index if not exists bk_jobs_business_job_number_uidx
  on public.bk_jobs (business_id, job_number)
  where job_number is not null;
