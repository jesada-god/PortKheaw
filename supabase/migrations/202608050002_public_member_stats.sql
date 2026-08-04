begin;

-- A single, non-identifying row for public product statistics. Realtime and
-- anonymous reads stop here: neither profiles nor auth.users is published or
-- opened beyond its existing owner-only policy.
create table if not exists public.app_public_stats (
  singleton boolean primary key default true check (singleton),
  member_count bigint not null default 0 check (member_count >= 0),
  updated_at timestamptz not null default now()
);

-- Backfill from the source of truth. The current profiles schema has no soft
-- delete column; the dynamic branch keeps the migration correct if one was
-- added by an environment before this release.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'deleted_at'
  ) then
    execute $backfill$
      insert into public.app_public_stats (singleton, member_count, updated_at)
      select true, count(*)::bigint, statement_timestamp()
      from public.profiles
      where deleted_at is null
      on conflict (singleton) do update set
        member_count = excluded.member_count,
        updated_at = excluded.updated_at
    $backfill$;
  else
    insert into public.app_public_stats (singleton, member_count, updated_at)
    select true, count(*)::bigint, statement_timestamp()
    from public.profiles
    on conflict (singleton) do update set
      member_count = excluded.member_count,
      updated_at = excluded.updated_at;
  end if;
end;
$$;

-- AFTER-row changes run in the profile transaction. A rollback therefore also
-- rolls back the aggregate update. Reading deleted_at through jsonb makes the
-- same function support schemas with and without a soft-delete column.
create or replace function public.sync_app_public_member_count()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  old_active boolean := false;
  new_active boolean := false;
  delta integer := 0;
begin
  if tg_op <> 'INSERT' then
    old_active := (to_jsonb(old) ->> 'deleted_at') is null;
  end if;
  if tg_op <> 'DELETE' then
    new_active := (to_jsonb(new) ->> 'deleted_at') is null;
  end if;

  delta := new_active::integer - old_active::integer;
  if delta <> 0 then
    update public.app_public_stats
    set
      member_count = member_count + delta,
      updated_at = statement_timestamp()
    where singleton = true;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists on_profile_sync_public_member_count on public.profiles;
create trigger on_profile_sync_public_member_count
  after insert or update or delete on public.profiles
  for each row execute procedure public.sync_app_public_member_count();

revoke all on function public.sync_app_public_member_count()
  from public, anon, authenticated;

alter table public.app_public_stats enable row level security;

drop policy if exists "Public stats are readable" on public.app_public_stats;
create policy "Public stats are readable"
  on public.app_public_stats
  for select
  to anon, authenticated
  using (true);

revoke all on table public.app_public_stats from public, anon, authenticated;
grant select on table public.app_public_stats to anon, authenticated;

-- Supabase owns this publication in hosted environments. Keep identifying
-- sources out even if an older environment accidentally added profiles, and
-- publish only the aggregate introduced here.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'profiles'
    ) then
      alter publication supabase_realtime drop table public.profiles;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'app_public_stats'
    ) then
      alter publication supabase_realtime add table public.app_public_stats;
    end if;
  end if;
end;
$$;

commit;
