begin;

create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'basic',
  status text not null default 'basic',
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  billing_customer_id text,
  billing_subscription_id text,
  billing_price_id text,
  founder_promo_applied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_subscriptions_tier_check check (tier in ('basic', 'pro', 'elite')),
  constraint user_subscriptions_status_check check (
    status in ('basic', 'trialing', 'active', 'past_due', 'canceled', 'expired')
  ),
  constraint user_subscriptions_trial_window_check check (
    trial_started_at is null or trial_ends_at is null or trial_ends_at >= trial_started_at
  ),
  constraint user_subscriptions_period_window_check check (
    current_period_start is null or current_period_end is null or current_period_end >= current_period_start
  )
);

-- Keep this migration replayable if a development database contains a partial
-- version of the table from an interrupted local migration.
alter table public.user_subscriptions
  add column if not exists tier text not null default 'basic',
  add column if not exists status text not null default 'basic',
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists trial_used_at timestamptz,
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists billing_customer_id text,
  add column if not exists billing_subscription_id text,
  add column if not exists billing_price_id text,
  add column if not exists founder_promo_applied boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_tier_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_tier_check check (tier in ('basic', 'pro', 'elite'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_status_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_status_check check (
        status in ('basic', 'trialing', 'active', 'past_due', 'canceled', 'expired')
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_trial_window_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_trial_window_check check (
        trial_started_at is null or trial_ends_at is null or trial_ends_at >= trial_started_at
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_period_window_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_period_window_check check (
        current_period_start is null or current_period_end is null or current_period_end >= current_period_start
      );
  end if;
end;
$$;

-- Customer and subscription identifiers belong to one account. Price
-- identifiers deliberately remain reusable across many subscriptions.
create unique index if not exists user_subscriptions_billing_customer_id_key
  on public.user_subscriptions (billing_customer_id)
  where billing_customer_id is not null;
create unique index if not exists user_subscriptions_billing_subscription_id_key
  on public.user_subscriptions (billing_subscription_id)
  where billing_subscription_id is not null;

create or replace function public.set_user_subscriptions_updated_at()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

drop trigger if exists user_subscriptions_set_updated_at on public.user_subscriptions;
create trigger user_subscriptions_set_updated_at
  before update on public.user_subscriptions
  for each row execute function public.set_user_subscriptions_updated_at();

revoke all on function public.set_user_subscriptions_updated_at() from public, anon, authenticated;

insert into public.user_subscriptions (user_id)
select id from auth.users
on conflict (user_id) do nothing;

alter table public.user_subscriptions enable row level security;

drop policy if exists "Users can read own subscription" on public.user_subscriptions;
create policy "Users can read own subscription" on public.user_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.user_subscriptions from anon, authenticated;
grant select on table public.user_subscriptions to authenticated;

-- This database resolver is private to trusted functions and triggers. Client
-- input can never select a tier or status for an entitlement decision.
create or replace function public.resolve_effective_subscription_tier(
  input_user_id uuid,
  input_as_of timestamptz
)
returns text
language sql
stable
security definer set search_path = ''
as $$
  select coalesce((
    select case
      when subscription.status = 'trialing'
        and subscription.trial_ends_at is not null
        and subscription.trial_ends_at > input_as_of
        then 'elite'
      when subscription.status = 'active'
        and subscription.current_period_end is not null
        and subscription.current_period_end > input_as_of
        then subscription.tier
      else 'basic'
    end
    from public.user_subscriptions as subscription
    where subscription.user_id = input_user_id
  ), 'basic')
$$;

revoke all on function public.resolve_effective_subscription_tier(uuid,timestamptz)
  from public, anon, authenticated;

-- Server-rendered UI receives the database clock alongside the authenticated
-- user's row, so components never perform scattered local-clock checks.
create or replace function public.get_my_subscription_snapshot()
returns table (
  user_id uuid,
  tier text,
  status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  billing_customer_id text,
  billing_subscription_id text,
  billing_price_id text,
  founder_promo_applied boolean,
  created_at timestamptz,
  updated_at timestamptz,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    viewer.user_id,
    coalesce(subscription.tier, 'basic'),
    coalesce(subscription.status, 'basic'),
    subscription.trial_started_at,
    subscription.trial_ends_at,
    subscription.trial_used_at,
    subscription.current_period_start,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end, false),
    subscription.billing_customer_id,
    subscription.billing_subscription_id,
    subscription.billing_price_id,
    coalesce(subscription.founder_promo_applied, false),
    subscription.created_at,
    subscription.updated_at,
    statement_timestamp()
  from (select auth.uid() as user_id) as viewer
  left join public.user_subscriptions as subscription
    on subscription.user_id = viewer.user_id
  where viewer.user_id is not null
$$;

revoke all on function public.get_my_subscription_snapshot() from public, anon;
grant execute on function public.get_my_subscription_snapshot() to authenticated;

-- Replace the existing atomic 10-per-type guard with tier-aware limits. The
-- advisory lock remains the serialization boundary for concurrent requests.
create or replace function public.enforce_portfolio_limit()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  active_count integer;
  effective_tier text;
  portfolio_limit integer;
begin
  if new.portfolio_type not in ('STOCK', 'OPTION') or new.archived_at is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.user_id::text || ':' || new.portfolio_type, 0)
  );
  effective_tier := public.resolve_effective_subscription_tier(
    new.user_id,
    statement_timestamp()
  );

  if new.portfolio_type = 'OPTION' and effective_tier = 'basic' then
    raise exception 'UPGRADE_REQUIRED:portfolio.options.create'
      using errcode = 'P0001';
  end if;

  portfolio_limit := case
    when effective_tier = 'basic' then 1
    else 10
  end;

  select count(*) into active_count
  from public.portfolios as portfolio
  where portfolio.user_id = new.user_id
    and portfolio.portfolio_type = new.portfolio_type
    and portfolio.archived_at is null
    and portfolio.id <> new.id;

  if active_count >= portfolio_limit then
    raise exception 'LIMIT_REACHED:%:%', new.portfolio_type, portfolio_limit
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_portfolio_limit() from public, anon, authenticated;

-- Extend the one existing auth.users trigger function. Subscription setup is
-- isolated so a non-critical insert failure cannot abort account creation.
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

  insert into public.portfolios (user_id, name, portfolio_type, is_legacy)
  values (new.id, 'Default / Legacy', 'LEGACY', true)
  on conflict (user_id) where is_legacy do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
