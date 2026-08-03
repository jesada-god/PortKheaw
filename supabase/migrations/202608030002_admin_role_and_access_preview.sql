begin;

-- Phase 3.1 adds two things that are deliberately kept apart from Phase 1–3:
--
--   `user_roles`            — who operates PortKheaw. An owner-admin role that
--                             has nothing to do with what anyone has paid for.
--   `admin_access_previews` — a short-lived, admin-only way to *look at* the app
--                             through another plan's entitlements, so the real
--                             paywalls can be exercised without touching a
--                             single subscription, billing or trial field.
--
-- Nothing here alters `user_subscriptions`, its constraints, its policies or any
-- row in it. No table, column, policy, grant or function from an earlier
-- migration is dropped. The one existing function that is replaced is
-- `handle_new_user()`, which is extended with a single additional insert.

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_roles_role_check check (role in ('user', 'admin'))
);

-- Keep this migration replayable if a development database contains a partial
-- version of the table from an interrupted local migration.
alter table public.user_roles
  add column if not exists role text not null default 'user',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_roles'::regclass
      and conname = 'user_roles_role_check'
  ) then
    alter table public.user_roles
      add constraint user_roles_role_check check (role in ('user', 'admin'));
  end if;
end;
$$;

create or replace function public.set_user_roles_updated_at()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

drop trigger if exists user_roles_set_updated_at on public.user_roles;
create trigger user_roles_set_updated_at
  before update on public.user_roles
  for each row execute function public.set_user_roles_updated_at();

revoke all on function public.set_user_roles_updated_at() from public, anon, authenticated;

-- Every account that already exists becomes an ordinary user. The owner seed
-- below is the only row this migration promotes.
insert into public.user_roles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

alter table public.user_roles enable row level security;

drop policy if exists "Users can read own role" on public.user_roles;
create policy "Users can read own role" on public.user_roles
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only for the account itself, and nothing at all for anon. No INSERT,
-- UPDATE or DELETE grant exists, so a client holding a valid session still has
-- no path to write a role — not its own, not anyone else's.
revoke all on table public.user_roles from anon, authenticated;
grant select on table public.user_roles to authenticated;

-- The PortKheaw owner, seeded as a UUID literal.
--
-- The identity is the immutable `auth.users.id`, never an email or a display
-- name, so changing either at any point in the future cannot grant or remove
-- administrator access. The foreign key above is what makes this safe to write
-- down: if this UUID were not a real account, the migration would fail here
-- rather than quietly seed an administrator that does not exist.
insert into public.user_roles (user_id, role)
values ('52e7b434-1dca-4636-88ab-ea9bdf063761', 'admin')
on conflict (user_id) do update set role = 'admin';

-- A time-boxed view of the product through another plan's entitlements.
--
-- One row per administrator at most, and the row is only ever written by the
-- trusted routines below. `expires_at` is what makes the state safe to hold: a
-- forgotten preview stops applying on its own, and the account returns to its
-- real access without anyone having to remember to undo anything.
create table if not exists public.admin_access_previews (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint admin_access_previews_mode_check check (
    mode in ('actual', 'basic', 'pro', 'elite', 'elite_trial', 'expired_trial')
  )
);

alter table public.admin_access_previews
  add column if not exists mode text not null,
  add column if not exists expires_at timestamptz not null,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.admin_access_previews'::regclass
      and conname = 'admin_access_previews_mode_check'
  ) then
    alter table public.admin_access_previews
      add constraint admin_access_previews_mode_check check (
        mode in ('actual', 'basic', 'pro', 'elite', 'elite_trial', 'expired_trial')
      );
  end if;
end;
$$;

alter table public.admin_access_previews enable row level security;

-- Least privilege: this table has no grant to anon or authenticated at all, so
-- the trusted resolver below is the only way to observe a preview. The own-row
-- policy is kept anyway, so that a future grant cannot widen the table beyond
-- the account it belongs to by omission.
drop policy if exists "Users can read own access preview" on public.admin_access_previews;
create policy "Users can read own access preview" on public.admin_access_previews
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.admin_access_previews from anon, authenticated;

-- How long a preview lasts. Long enough to walk every paywall on the site,
-- short enough that walking away from the machine restores real access.
create or replace function public.admin_access_preview_duration()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '60 minutes' $$;

revoke all on function public.admin_access_preview_duration() from public, anon, authenticated;

-- The one resolver every entitlement surface reads.
--
-- Role, preview and subscription are answered together, from the database
-- clock, in a single round trip. Three properties are decided here rather than
-- in the application, so no caller can get them wrong:
--
--   * a missing role row resolves to 'user' — fail closed;
--   * an expired preview is not returned at all, which is what makes a preview
--     revert to real access on its own;
--   * a preview held by an account that is not currently an administrator is
--     not returned either, so demoting an account withdraws its preview in the
--     same instant.
--
-- Billing identifiers are deliberately absent from the projection.
create or replace function public.get_my_account_access()
returns table (
  user_id uuid,
  role text,
  preview_mode text,
  preview_expires_at timestamptz,
  tier text,
  status text,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  current_period_end timestamptz,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    viewer.user_id,
    coalesce(roles.role, 'user'),
    case
      when roles.role = 'admin'
        and preview.mode is not null
        and preview.expires_at > statement_timestamp()
        then preview.mode
      else 'actual'
    end,
    case
      when roles.role = 'admin'
        and preview.mode is not null
        and preview.expires_at > statement_timestamp()
        then preview.expires_at
      else null
    end,
    coalesce(subscription.tier, 'basic'),
    coalesce(subscription.status, 'basic'),
    subscription.trial_ends_at,
    subscription.trial_used_at,
    subscription.current_period_end,
    statement_timestamp()
  from (select auth.uid() as user_id) as viewer
  left join public.user_roles as roles on roles.user_id = viewer.user_id
  left join public.admin_access_previews as preview on preview.user_id = viewer.user_id
  left join public.user_subscriptions as subscription on subscription.user_id = viewer.user_id
  where viewer.user_id is not null
$$;

revoke all on function public.get_my_account_access() from public, anon;
grant execute on function public.get_my_account_access() to authenticated;

-- Start or change a preview.
--
-- No user id is accepted: the caller is read from `auth.uid()`, the role is
-- verified against `user_roles` inside the database, and the mode is checked
-- against a closed allowlist. A caller who is not an administrator is refused
-- with ADMIN_REQUIRED whatever they send, and whatever preview they are
-- currently inside — the check reads the stored role, never the preview.
--
-- `insert ... on conflict do update` is the whole concurrency story: two
-- requests that arrive together leave exactly one row, and the second one wins
-- rather than failing.
--
-- Nothing in this routine reads or writes `public.user_subscriptions`.
create or replace function public.set_my_admin_access_preview(input_mode text)
returns table (mode text, expires_at timestamptz, database_now timestamptz)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  granted_at timestamptz := now();
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if input_mode is null or input_mode not in (
    'actual', 'basic', 'pro', 'elite', 'elite_trial', 'expired_trial'
  ) then
    raise exception 'INVALID_PREVIEW_MODE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.user_roles as viewer
    where viewer.user_id = requesting_user and viewer.role = 'admin'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- 'actual' is not a stored state, it is the absence of one.
  if input_mode = 'actual' then
    delete from public.admin_access_previews as target
    where target.user_id = requesting_user;
    return query select 'actual'::text, null::timestamptz, statement_timestamp();
    return;
  end if;

  insert into public.admin_access_previews (user_id, mode, expires_at, updated_at)
  values (
    requesting_user,
    input_mode,
    granted_at + public.admin_access_preview_duration(),
    granted_at
  )
  on conflict (user_id) do update
    set mode = excluded.mode,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at;

  return query
  select target.mode, target.expires_at, statement_timestamp()
  from public.admin_access_previews as target
  where target.user_id = requesting_user;
end;
$$;

revoke all on function public.set_my_admin_access_preview(text) from public, anon;
grant execute on function public.set_my_admin_access_preview(text) to authenticated;

-- Return to real access. Same identity and role rules as starting one; a row
-- that is already gone is not an error, so the control is safe to press twice.
create or replace function public.clear_my_admin_access_preview()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.user_roles as viewer
    where viewer.user_id = requesting_user and viewer.role = 'admin'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  delete from public.admin_access_previews as target
  where target.user_id = requesting_user;
end;
$$;

revoke all on function public.clear_my_admin_access_preview() from public, anon;
grant execute on function public.clear_my_admin_access_preview() to authenticated;

-- Extend the one existing auth.users trigger function. The role insert is
-- isolated in its own block for the same reason the subscription insert is: a
-- non-critical failure must not abort account creation. A signup that somehow
-- lands without a role row still resolves to 'user' in the resolver above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  insert into public.watchlists (user_id, name) values (new.id, 'รายการโปรด')
  on conflict (user_id) do nothing;

  begin
    insert into public.user_subscriptions (user_id) values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'Could not initialize subscription for auth user %: %', new.id, sqlerrm;
  end;

  begin
    insert into public.user_roles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'Could not initialize role for auth user %: %', new.id, sqlerrm;
  end;

  insert into public.portfolios (user_id, name, portfolio_type, is_legacy)
  values (new.id, 'Default / Legacy', 'LEGACY', true)
  on conflict (user_id) where is_legacy do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
