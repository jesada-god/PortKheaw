begin;

-- Phase 4 turns the subscription table from a record of what we granted into a
-- record of what a payment provider confirmed. It is deliberately additive:
--
--   * `user_subscriptions` gains columns and loses none. Every column, index,
--     constraint, policy, grant and row from Phase 1–3.1 survives untouched.
--   * `billing_webhook_events` is new, and is the idempotency ledger that makes
--     a redelivered webhook a no-op.
--   * `apply_billing_subscription_event()` is new, and is the ONLY way billing
--     state changes. It is not granted to `anon` or `authenticated`.
--   * `get_my_billing_snapshot()` is new rather than a redefinition of
--     `get_my_subscription_snapshot()`, so no function already serving
--     production has its signature changed by this migration.
--
-- The one existing routine this replaces is `resolve_effective_subscription_tier`,
-- whose signature is unchanged. It gains the dunning grace rule described below.

-- ---------------------------------------------------------------------------
-- 1. Billing columns
-- ---------------------------------------------------------------------------

alter table public.user_subscriptions
  add column if not exists billing_provider text,
  add column if not exists billing_plan_key text,
  add column if not exists billing_interval text,
  add column if not exists latest_invoice_id text,
  add column if not exists latest_payment_status text,
  add column if not exists latest_payment_at timestamptz,
  -- The provider's own clock for the last event applied to this row. This is the
  -- ordering key that stops a redelivered older event from undoing a newer one.
  add column if not exists provider_event_at timestamptz,
  add column if not exists provider_event_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_billing_provider_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_billing_provider_check
      check (billing_provider is null or billing_provider in ('stripe'));
  end if;

  -- The same closed allowlist the application ships. A plan key that is not on
  -- it cannot be written even by a trusted caller with a bug.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_billing_plan_key_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_billing_plan_key_check
      check (billing_plan_key is null or billing_plan_key in (
        'pro_monthly', 'pro_annual', 'pro_annual_founder',
        'elite_monthly', 'elite_annual', 'elite_annual_founder'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_billing_interval_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_billing_interval_check
      check (billing_interval is null or billing_interval in ('month', 'year'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_latest_payment_status_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_latest_payment_status_check
      check (latest_payment_status is null or latest_payment_status in ('succeeded', 'failed'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The webhook ledger
-- ---------------------------------------------------------------------------
--
-- One row per provider event, ever. `provider_event_id` is unique, and claiming
-- that row is what makes processing idempotent: a redelivery loses the insert
-- race and is answered without touching a single entitlement column.
--
-- What is deliberately NOT here: the request body, card details, customer email,
-- provider secrets. Only a digest of the payload is kept, which is enough to
-- prove two deliveries carried the same bytes and useless to anyone who reads it.

create table if not exists public.billing_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  status text not null default 'received',
  -- Deliberately NOT a foreign key. This is a ledger of provider traffic, and it
  -- has to be able to record a delivery that names an account we do not have —
  -- a mis-routed event, or one for an account since deleted. A reference here
  -- would make that insert fail, the routine raise, and the endpoint answer 500,
  -- which would put the provider into an unbounded retry loop over an event that
  -- can never succeed.
  user_id uuid,
  -- The provider's clock for this event, kept for forensics on out-of-order runs.
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_code text,
  payload_digest text,
  constraint billing_webhook_events_provider_check check (provider in ('stripe')),
  constraint billing_webhook_events_status_check check (
    status in ('received', 'applied', 'ignored', 'stale', 'duplicate', 'failed')
  )
);

alter table public.billing_webhook_events
  add column if not exists status text not null default 'received',
  add column if not exists user_id uuid,
  add column if not exists occurred_at timestamptz,
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists processed_at timestamptz,
  add column if not exists error_code text,
  add column if not exists payload_digest text;

create unique index if not exists billing_webhook_events_provider_event_id_key
  on public.billing_webhook_events (provider, provider_event_id);

create index if not exists billing_webhook_events_user_id_idx
  on public.billing_webhook_events (user_id, received_at desc);

alter table public.billing_webhook_events enable row level security;

-- Least privilege, stated twice. No grant to anon or authenticated at all, and no
-- policy that would let a future grant widen this table by omission. A reader
-- never sees the webhook ledger — not even their own rows.
revoke all on table public.billing_webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Dunning grace
-- ---------------------------------------------------------------------------
--
-- A failed renewal does not end access on the spot. The provider retries for a
-- dunning window, and during it the subscription keeps the period it was already
-- granted — so `past_due` continues to open the purchased tier until
-- `current_period_end`, and then stops on its own.
--
-- The bound is a timestamp the provider set. There is no timer of ours involved,
-- which is what stops a stalled dunning cycle from becoming unlimited free
-- access. When the provider gives up it sends `unpaid` or `canceled`, which map
-- to `expired` and `canceled` here and grant nothing.
--
-- The application implements the identical rule in `resolveEffectiveTier`, and
-- the two are checked against each other in tests.
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
      when subscription.status in ('active', 'past_due')
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

-- ---------------------------------------------------------------------------
-- 4. The one trusted write path
-- ---------------------------------------------------------------------------
--
-- Everything about a paid subscription changes here and nowhere else. The
-- function is not granted to `anon` or `authenticated`, so a client holding a
-- valid session cannot reach it at all; the webhook route calls it with the
-- service role after it has verified the provider's signature.
--
-- The order of operations is the safety argument:
--
--   1. Claim the event id. Losing that race means this is a redelivery, and the
--      function returns `duplicate` without reading or writing entitlement.
--   2. Lock the subscription row. Two events for one account serialize here
--      rather than interleaving into a half-applied state.
--   3. Refuse on identity mismatch. An event whose customer does not match the
--      customer already stored against the account fails closed.
--   4. Refuse a stale event, by comparing the provider's clocks.
--   5. Apply, then mark processed — in that order, in one transaction, so a
--      failure after the update cannot leave the event marked done.
--
-- Role and preview columns are never read or written here. A webhook cannot
-- promote anyone to administrator, and cannot end a running preview.
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
declare
  claimed_id bigint;
  existing public.user_subscriptions%rowtype;
  failure text;
begin
  if input_provider is null or input_event_id is null or input_event_type is null then
    raise exception 'BILLING_EVENT_INCOMPLETE' using errcode = 'P0001';
  end if;

  -- (1) Idempotency. The unique index is the arbiter, not a prior SELECT.
  insert into public.billing_webhook_events (
    provider, provider_event_id, event_type, status, user_id, occurred_at, payload_digest
  )
  values (
    input_provider, input_event_id, input_event_type, 'received',
    input_user_id, input_occurred_at, input_payload_digest
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into claimed_id;

  if claimed_id is null then
    return query select 'duplicate'::text, input_user_id;
    return;
  end if;

  -- An event we understood but that asserts no entitlement change is recorded
  -- and finished with. This is how refunds, disputes and everything outside the
  -- subscription lifecycle stay visible without touching anyone's access.
  if input_user_id is null or input_status is null then
    update public.billing_webhook_events
      set status = 'ignored', processed_at = statement_timestamp()
      where id = claimed_id;
    return query select 'ignored'::text, input_user_id;
    return;
  end if;

  -- (2) Serialize per account.
  select * into existing
  from public.user_subscriptions
  where user_id = input_user_id
  for update;

  if not found then
    update public.billing_webhook_events
      set status = 'failed', error_code = 'unknown_user', processed_at = statement_timestamp()
      where id = claimed_id;
    return query select 'unknown_user'::text, input_user_id;
    return;
  end if;

  -- (3) Identity must not drift. A customer or subscription identifier that
  -- disagrees with what is already stored is a routing error, and guessing which
  -- one is right is exactly the mistake that moves a plan onto the wrong account.
  failure := null;
  if existing.billing_customer_id is not null
     and input_customer_id is not null
     and existing.billing_customer_id <> input_customer_id then
    failure := 'customer_mismatch';
  elsif existing.billing_subscription_id is not null
     and input_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id then
    failure := 'subscription_mismatch';
  end if;

  if failure is not null then
    update public.billing_webhook_events
      set status = 'failed', error_code = failure, processed_at = statement_timestamp()
      where id = claimed_id;
    return query select failure, input_user_id;
    return;
  end if;

  -- (4) Out-of-order delivery. Equal timestamps are allowed through: two events
  -- can share a second, and the row lock above means the later arrival simply
  -- wins rather than being dropped.
  if existing.provider_event_at is not null
     and input_occurred_at is not null
     and input_occurred_at < existing.provider_event_at then
    update public.billing_webhook_events
      set status = 'stale', processed_at = statement_timestamp()
      where id = claimed_id;
    return query select 'stale'::text, input_user_id;
    return;
  end if;

  -- (5) Apply. Trial columns are untouched: a paid subscription neither grants
  -- nor returns the one-per-account Elite trial.
  update public.user_subscriptions
    set
      tier = coalesce(input_tier, tier),
      status = input_status,
      billing_provider = coalesce(input_provider, billing_provider),
      billing_plan_key = coalesce(input_plan_key, billing_plan_key),
      billing_interval = coalesce(input_interval, billing_interval),
      billing_customer_id = coalesce(input_customer_id, billing_customer_id),
      billing_subscription_id = coalesce(input_subscription_id, billing_subscription_id),
      billing_price_id = coalesce(input_price_id, billing_price_id),
      current_period_start = coalesce(input_period_start, current_period_start),
      current_period_end = coalesce(input_period_end, current_period_end),
      cancel_at_period_end = coalesce(input_cancel_at_period_end, cancel_at_period_end),
      latest_invoice_id = coalesce(input_invoice_id, latest_invoice_id),
      latest_payment_status = coalesce(input_payment_status, latest_payment_status),
      latest_payment_at = case
        when input_payment_status is not null then statement_timestamp()
        else latest_payment_at
      end,
      -- Once a Founder period has been billed it stays spent, whatever a later
      -- event says. This is the flag the checkout guard reads.
      founder_promo_applied = founder_promo_applied or coalesce(input_founder, false),
      provider_event_at = coalesce(input_occurred_at, provider_event_at),
      provider_event_id = input_event_id
    where user_id = input_user_id;

  update public.billing_webhook_events
    set status = 'applied', processed_at = statement_timestamp()
    where id = claimed_id;

  return query select 'applied'::text, input_user_id;
end;
$$;

revoke all on function public.apply_billing_subscription_event(
  text, text, text, timestamptz, text, uuid, text, text, text, text, text, text,
  text, timestamptz, timestamptz, boolean, text, text, boolean
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. What a reader may see of their own billing
-- ---------------------------------------------------------------------------
--
-- A new function rather than a change to `get_my_subscription_snapshot()`, so
-- nothing already serving production has its signature altered here.
--
-- Sanitized on purpose. The customer, subscription, price and invoice
-- identifiers are NOT in this projection: the manage page needs to say what plan
-- is held, when it renews and for how much, and none of those answers require a
-- provider identifier to reach the browser.
create or replace function public.get_my_billing_snapshot()
returns table (
  user_id uuid,
  tier text,
  status text,
  billing_provider text,
  billing_plan_key text,
  billing_interval text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  founder_promo_applied boolean,
  latest_payment_status text,
  latest_payment_at timestamptz,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  has_billing_customer boolean,
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
    subscription.billing_provider,
    subscription.billing_plan_key,
    subscription.billing_interval,
    subscription.current_period_start,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end, false),
    coalesce(subscription.founder_promo_applied, false),
    subscription.latest_payment_status,
    subscription.latest_payment_at,
    subscription.trial_ends_at,
    subscription.trial_used_at,
    -- Whether a billing portal can be opened, without disclosing the identifier
    -- that opens it.
    subscription.billing_customer_id is not null,
    statement_timestamp()
  from (select auth.uid() as user_id) as viewer
  left join public.user_subscriptions as subscription
    on subscription.user_id = viewer.user_id
  where viewer.user_id is not null
$$;

revoke all on function public.get_my_billing_snapshot() from public, anon;
grant execute on function public.get_my_billing_snapshot() to authenticated;

commit;
