begin;

-- Phase 4.2 makes the provider environment part of every billing identity.
-- Existing identifiers cannot prove which Stripe environment created them, so
-- they are labelled `legacy_unknown`; no identifier is deleted or guessed.
alter table public.user_subscriptions
  add column if not exists billing_provider_mode text;

update public.user_subscriptions
set billing_provider_mode = 'legacy_unknown'
where billing_provider_mode is null
  and (
    billing_provider is not null
    or billing_customer_id is not null
    or billing_subscription_id is not null
    or billing_price_id is not null
    or provider_event_id is not null
  );

-- An unclassified paid record is evidence to investigate, not evidence of an
-- entitlement. Preserve every provider identifier while withdrawing only the
-- paid grant that cannot be trusted. Trial rows are not touched.
update public.user_subscriptions
set tier = 'basic', status = 'basic'
where billing_provider_mode = 'legacy_unknown'
  and status in ('active', 'past_due');

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_billing_provider_mode_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_billing_provider_mode_check
      check (billing_provider_mode is null or billing_provider_mode in ('test', 'live', 'legacy_unknown'));
  end if;
end;
$$;

alter table public.billing_webhook_events
  add column if not exists provider_mode text;

update public.billing_webhook_events
set provider_mode = 'legacy_unknown'
where provider_mode is null;

alter table public.billing_webhook_events
  alter column provider_mode set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.billing_webhook_events'::regclass
      and conname = 'billing_webhook_events_provider_mode_check'
  ) then
    alter table public.billing_webhook_events
      add constraint billing_webhook_events_provider_mode_check
      check (provider_mode in ('test', 'live', 'legacy_unknown'));
  end if;
end;
$$;

-- Replace the pre-Phase-4.2 uniqueness keys only after the mode column is fully
-- populated. Index replacement removes no row and is safe to replay.
drop index if exists public.billing_webhook_events_provider_event_id_key;
create unique index if not exists billing_webhook_events_provider_mode_event_id_key
  on public.billing_webhook_events (provider, provider_mode, provider_event_id);

drop index if exists public.user_subscriptions_billing_customer_id_key;
drop index if exists public.user_subscriptions_billing_subscription_id_key;
create unique index if not exists user_subscriptions_billing_customer_mode_key
  on public.user_subscriptions (billing_provider, billing_provider_mode, billing_customer_id)
  where billing_provider is not null
    and billing_provider_mode is not null
    and billing_customer_id is not null;
create unique index if not exists user_subscriptions_billing_subscription_mode_key
  on public.user_subscriptions (billing_provider, billing_provider_mode, billing_subscription_id)
  where billing_provider is not null
    and billing_provider_mode is not null
    and billing_subscription_id is not null;

-- The old unscoped RPC remains as a fail-closed compatibility stub. Keeping the
-- signature means a stale deployment receives a clear error instead of silently
-- applying an event without an environment identity.
create or replace function public.apply_billing_subscription_event(
  input_provider text,
  input_event_id text,
  input_event_type text,
  input_occurred_at timestamptz,
  input_payload_digest text,
  input_user_id uuid,
  input_customer_id text,
  input_subscription_id text,
  input_plan_key text,
  input_price_id text,
  input_tier text,
  input_status text,
  input_interval text,
  input_period_start timestamptz,
  input_period_end timestamptz,
  input_cancel_at_period_end boolean,
  input_invoice_id text,
  input_payment_status text,
  input_founder boolean
)
returns table (outcome text, applied_user_id uuid)
language plpgsql
security definer set search_path = ''
as $$
begin
  raise exception 'BILLING_PROVIDER_MODE_REQUIRED' using errcode = 'P0001';
end;
$$;

revoke all on function public.apply_billing_subscription_event(
  text, text, text, timestamptz, text, uuid, text, text, text, text, text, text,
  text, timestamptz, timestamptz, boolean, text, text, boolean
) from public, anon, authenticated;

-- The mode-scoped write path. Signature verification and event.livemode checks
-- happen before this function; the mode is nevertheless constrained and is
-- included in idempotency, identity matching, and staleness.
create or replace function public.apply_billing_subscription_event(
  input_provider text,
  input_provider_mode text,
  input_event_id text,
  input_event_type text,
  input_occurred_at timestamptz,
  input_payload_digest text,
  input_user_id uuid,
  input_customer_id text,
  input_subscription_id text,
  input_plan_key text,
  input_price_id text,
  input_tier text,
  input_status text,
  input_interval text,
  input_period_start timestamptz,
  input_period_end timestamptz,
  input_cancel_at_period_end boolean,
  input_invoice_id text,
  input_payment_status text,
  input_founder boolean
)
returns table (outcome text, applied_user_id uuid)
language plpgsql
security definer set search_path = ''
as $$
declare
  claimed_id bigint;
  existing public.user_subscriptions%rowtype;
  same_provider_identity boolean;
  failure text;
begin
  if input_provider is null
     or input_provider_mode not in ('test', 'live')
     or input_event_id is null
     or input_event_type is null then
    raise exception 'BILLING_EVENT_INCOMPLETE' using errcode = 'P0001';
  end if;

  insert into public.billing_webhook_events (
    provider, provider_mode, provider_event_id, event_type, status,
    user_id, occurred_at, payload_digest
  ) values (
    input_provider, input_provider_mode, input_event_id, input_event_type,
    'received', input_user_id, input_occurred_at, input_payload_digest
  )
  on conflict (provider, provider_mode, provider_event_id) do nothing
  returning id into claimed_id;

  if claimed_id is null then
    return query select 'duplicate'::text, input_user_id;
    return;
  end if;

  if input_user_id is null or input_status is null then
    update public.billing_webhook_events
      set status = 'ignored', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'ignored'::text, input_user_id;
    return;
  end if;

  if input_customer_id is null or input_subscription_id is null then
    update public.billing_webhook_events
      set status = 'failed', error_code = 'identity_incomplete', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'identity_incomplete'::text, input_user_id;
    return;
  end if;

  select * into existing
  from public.user_subscriptions
  where user_id = input_user_id
  for update;

  if not found then
    update public.billing_webhook_events
      set status = 'failed', error_code = 'unknown_user', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'unknown_user'::text, input_user_id;
    return;
  end if;

  same_provider_identity := existing.billing_provider = input_provider
    and existing.billing_provider_mode = input_provider_mode;

  failure := null;
  if same_provider_identity
     and existing.billing_customer_id is not null
     and existing.billing_customer_id <> input_customer_id then
    failure := 'customer_mismatch';
  elsif same_provider_identity
     and existing.billing_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id then
    failure := 'subscription_mismatch';
  end if;

  if failure is not null then
    update public.billing_webhook_events
      set status = 'failed', error_code = failure, processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select failure, input_user_id;
    return;
  end if;

  if same_provider_identity
     and existing.provider_event_at is not null
     and input_occurred_at is not null
     and input_occurred_at < existing.provider_event_at then
    update public.billing_webhook_events
      set status = 'stale', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'stale'::text, input_user_id;
    return;
  end if;

  update public.user_subscriptions
  set
    tier = coalesce(input_tier, tier),
    status = input_status,
    billing_provider = input_provider,
    billing_provider_mode = input_provider_mode,
    billing_plan_key = case when same_provider_identity then coalesce(input_plan_key, billing_plan_key) else input_plan_key end,
    billing_interval = case when same_provider_identity then coalesce(input_interval, billing_interval) else input_interval end,
    billing_customer_id = case when same_provider_identity then coalesce(input_customer_id, billing_customer_id) else input_customer_id end,
    billing_subscription_id = case when same_provider_identity then coalesce(input_subscription_id, billing_subscription_id) else input_subscription_id end,
    billing_price_id = case when same_provider_identity then coalesce(input_price_id, billing_price_id) else input_price_id end,
    current_period_start = coalesce(input_period_start, current_period_start),
    current_period_end = coalesce(input_period_end, current_period_end),
    cancel_at_period_end = coalesce(input_cancel_at_period_end, cancel_at_period_end),
    latest_invoice_id = coalesce(input_invoice_id, latest_invoice_id),
    latest_payment_status = coalesce(input_payment_status, latest_payment_status),
    latest_payment_at = case when input_payment_status is not null then statement_timestamp() else latest_payment_at end,
    founder_promo_applied = founder_promo_applied or coalesce(input_founder, false),
    provider_event_at = input_occurred_at,
    provider_event_id = input_event_id
  where user_id = input_user_id;

  update public.billing_webhook_events
    set status = 'applied', processed_at = statement_timestamp()
    where id = claimed_id
      and provider = input_provider
      and provider_mode = input_provider_mode
      and provider_event_id = input_event_id;

  return query select 'applied'::text, input_user_id;
end;
$$;

revoke all on function public.apply_billing_subscription_event(
  text, text, text, text, timestamptz, text, uuid, text, text, text, text, text,
  text, text, timestamptz, timestamptz, boolean, text, text, boolean
) from public, anon, authenticated;

-- Paid access is valid only when its provider mode was proven. The Elite trial
-- remains independent of billing and keeps its existing behavior.
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
      when subscription.billing_provider_mode in ('test', 'live')
        and subscription.status in ('active', 'past_due')
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

commit;
