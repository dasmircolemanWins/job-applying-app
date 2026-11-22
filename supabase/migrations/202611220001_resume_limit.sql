begin;

create or replace function public.enforce_applypilot_resume_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if new.owner_id is distinct from auth.uid() then
    raise insufficient_privilege using message = 'Resume owner must match the authenticated user';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text, 0));
  if (select count(*) from public.resumes where owner_id = new.owner_id) >= 10 then
    raise check_violation using message = 'At most 10 resumes can be stored';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_applypilot_resume_limit() from public, anon, authenticated;

drop trigger if exists applypilot_resume_limit on public.resumes;
create trigger applypilot_resume_limit
before insert on public.resumes
for each row execute function public.enforce_applypilot_resume_limit();

create unique index if not exists applypilot_applications_owner_job_unique
on public.applications(owner_id, job_id)
where job_id is not null;

create or replace function public.applypilot_hosted_constraints_ready()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'resumes'
      and t.tgname = 'applypilot_resume_limit'
      and not t.tgisinternal
      and t.tgenabled = 'O'
  ) and exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
    join pg_catalog.pg_class tbl on tbl.oid = i.indrelid
    join pg_catalog.pg_namespace n on n.oid = tbl.relnamespace
    where n.nspname = 'public'
      and tbl.relname = 'applications'
      and idx.relname = 'applypilot_applications_owner_job_unique'
      and i.indisunique
      and i.indisvalid
  );
$$;

revoke all on function public.applypilot_hosted_constraints_ready() from public, anon;
grant execute on function public.applypilot_hosted_constraints_ready() to authenticated;

commit;
