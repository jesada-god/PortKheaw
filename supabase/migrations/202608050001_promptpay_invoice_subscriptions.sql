begin;

-- Phase 4.4 adds a second payment rail: PromptPay, which the provider can only
-- bill through an invoice (`collection_method = 'send_invoice'`).
--
-- The rail differs from a card in one way that matters to every line below: the
-- provider activates an invoice-collected subscription the moment it is created,
-- and advances its period as soon as each renewal invoice is *issued* — both
-- before any money has moved. Entitlement therefore cannot follow the
-- subscription on this rail; it follows paid invoices, and the application
-- enforces that in `gateEntitlementByCollectionMethod`.
--
-- What this migration adds:
--
--   * `user_subscriptions.billing_collection_method` — which rail a subscription
--     is on. Display, and one guard below.
--   * `billing_pending_payments` — an invoice that exists and has not been paid.
--     It grants nothing. It exists so a reader can find their own QR again, and
--     so a second purchase cannot be started while one is still payable.
--   * `record_pending_billing_payment()` / `apply_billing_payment_rail()` — both
--     service-role only, like every other billing write.
--   * A correction to `apply_billing_subscription_event()`: a stored
--     subscription identifier only blocks a different one while it is still
--     live. Without this, an account whose subscription has ended could never
--     buy again — every event for the new subscription would be refused as a
--     mismatch, so the reader would pay and be granted nothing. On the invoice
--     rail, "ended and bought again" is the ordinary lifecycle rather than an
--     edge case, which is what makes the correction necessary now.
--
-- Nothing here changes an existing function signature, and no row is deleted.

-- ---------------------------------------------------------------------------
-- 1. Which rail a subscription is billed on
-- ---------------------------------------------------------------------------

alter table public.user_subscriptions
  add column if not exists billing_collection_method text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_billing_collection_method_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_billing_collection_method_check
      check (billing_collection_method is null
        or billing_collection_method in ('charge_automatically', 'send_invoice'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. An invoice that has not been paid
-- ---------------------------------------------------------------------------
--
-- One row per account, because an account may have exactly one purchase in
-- flight. The row is not an entitlement and is never read by
-- `resolve_effective_subscription_tier`: it says "somebody started paying", and
-- the tier still opens only when a paid invoice arrives.
--
-- The reader may SELECT their own row — they need the hosted invoice address to
-- reach their own QR again from another device. They hold no INSERT, UPDATE or
-- DELETE: every write comes from the trusted routines below, after either a
-- verified provider response or a verified webhook signature.

create table if not exists public.billing_pending_payments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null,
  provider_mode text not null,
  payment_method text not null,
  plan_key text not null,
  -- The provider identifiers. Held for matching an incoming webhook to this row;
  -- the sanitized read the browser performs does not select them.
  subscription_id text not null,
  invoice_id text,
  -- The provider-hosted page that renders the QR. A per-invoice address, not a
  -- credential, and the only way to show somebody their own payment again.
  hosted_invoice_url text,
  amount_baht integer not null,
  status text not null default 'awaiting_payment',
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_pending_payments_provider_check check (provider in ('stripe')),
  constraint billing_pending_payments_provider_mode_check
    check (provider_mode in ('test', 'live')),
  constraint billing_pending_payments_payment_method_check
    check (payment_method in ('promptpay')),
  constraint billing_pending_payments_status_check
    check (status in ('awaiting_payment', 'paid', 'canceled', 'expired')),
  constraint billing_pending_payments_amount_check check (amount_baht > 0),
  constraint billing_pending_payments_plan_key_check check (plan_key in (
    'pro_monthly', 'pro_annual', 'pro_annual_founder',
    'elite_monthly', 'elite_annual', 'elite_annual_founder'
  ))
);

create index if not exists billing_pending_payments_subscription_idx
  on public.billing_pending_payments (provider, provider_mode, subscription_id);

alter table public.billing_pending_payments enable row level security;

drop policy if exists "read own pending payment" on public.billing_pending_payments;
create policy "read own pending payment"
  on public.billing_pending_payments
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.billing_pending_payments from anon, authenticated;
grant select on table public.billing_pending_payments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Recording a purchase that is in flight
-- ---------------------------------------------------------------------------
--
-- Called by the server action after the provider has created the invoice, with
-- the service role. It writes no entitlement column: tier, status, period and
-- the founder flag are all untouched here, and are reachable only from the
-- webhook's routine.
create or replace function public.record_pending_billing_payment(
  input_user_id uuid,
  input_provider text,
  input_provider_mode text,
  input_payment_method text,
  input_plan_key text,
  input_subscription_id text,
  input_invoice_id text,
  input_hosted_invoice_url text,
  input_amount_baht integer,
  input_due_at timestamptz
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  existing public.user_subscriptions%rowtype;
  pending public.billing_pending_payments%rowtype;
begin
  if input_user_id is null
     or input_provider is null
     or input_provider_mode not in ('test', 'live')
     or input_subscription_id is null
     or input_amount_baht is null then
    raise exception 'BILLING_PENDING_INCOMPLETE' using errcode = 'P0001';
  end if;

  select * into existing
  from public.user_subscriptions
  where user_id = input_user_id
  for update;

  if not found then
    return 'unknown_user';
  end if;

  -- Defence in depth. The checkout gate already refuses this, but a pending
  -- invoice recorded against an account that is already being billed for a
  -- different subscription is precisely the state that ends with somebody
  -- paying twice, so the trusted routine declines it as well.
  if existing.status in ('active', 'past_due')
     and existing.billing_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id
     and (existing.billing_collection_method is distinct from 'send_invoice'
          or (existing.current_period_end is not null
              and existing.current_period_end > statement_timestamp())) then
    return 'already_subscribed';
  end if;

  select * into pending
  from public.billing_pending_payments
  where user_id = input_user_id
  for update;

  if found
     and pending.status = 'awaiting_payment'
     and pending.subscription_id <> input_subscription_id
     and pending.due_at is not null
     and pending.due_at > statement_timestamp() then
    return 'pending_exists';
  end if;

  insert into public.billing_pending_payments as target (
    user_id, provider, provider_mode, payment_method, plan_key,
    subscription_id, invoice_id, hosted_invoice_url, amount_baht,
    status, due_at, created_at, updated_at
  ) values (
    input_user_id, input_provider, input_provider_mode, input_payment_method,
    input_plan_key, input_subscription_id, input_invoice_id,
    input_hosted_invoice_url, input_amount_baht,
    'awaiting_payment', input_due_at, statement_timestamp(), statement_timestamp()
  )
  on conflict (user_id) do update set
    provider = excluded.provider,
    provider_mode = excluded.provider_mode,
    payment_method = excluded.payment_method,
    plan_key = excluded.plan_key,
    subscription_id = excluded.subscription_id,
    invoice_id = excluded.invoice_id,
    hosted_invoice_url = excluded.hosted_invoice_url,
    amount_baht = excluded.amount_baht,
    status = 'awaiting_payment',
    due_at = excluded.due_at,
    created_at = case
      when target.subscription_id = excluded.subscription_id then target.created_at
      else statement_timestamp()
    end,
    updated_at = statement_timestamp();

  return 'recorded';
end;
$$;

revoke all on function public.record_pending_billing_payment(
  uuid, text, text, text, text, text, text, text, integer, timestamptz
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Settling a purchase that was in flight
-- ---------------------------------------------------------------------------
--
-- Runs after `apply_billing_subscription_event`, from the same verified webhook,
-- and from the abandon action. It records which rail the subscription is on and
-- clears a pending row that has been settled — paid, voided, written off or
-- abandoned.
--
-- It cannot grant anything: no tier, status, period or founder column appears
-- below. Both writes are scoped to a subscription identifier that must already
-- match what is stored, so an event for some other subscription changes nothing.
create or replace function public.apply_billing_payment_rail(
  input_user_id uuid,
  input_provider text,
  input_provider_mode text,
  input_subscription_id text,
  input_collection_method text,
  input_pending_settled boolean
)
returns table (rail_updated boolean, pending_cleared boolean)
language plpgsql
security definer set search_path = ''
as $$
declare
  updated_rail boolean := false;
  cleared_pending boolean := false;
begin
  if input_user_id is null
     or input_subscription_id is null
     or input_provider_mode not in ('test', 'live') then
    return query select false, false;
    return;
  end if;

  if input_collection_method in ('charge_automatically', 'send_invoice') then
    update public.user_subscriptions
      set billing_collection_method = input_collection_method
      where user_id = input_user_id
        and billing_provider = input_provider
        and billing_provider_mode = input_provider_mode
        and billing_subscription_id = input_subscription_id
        and billing_collection_method is distinct from input_collection_method;
    updated_rail := found;
  end if;

  if coalesce(input_pending_settled, false) then
    delete from public.billing_pending_payments
      where user_id = input_user_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and subscription_id = input_subscription_id;
    cleared_pending := found;
  end if;

  return query select updated_rail, cleared_pending;
end;
$$;

revoke all on function public.apply_billing_payment_rail(
  uuid, text, text, text, text, boolean
) from public, anon, authenticated;

-- Abandoning an unpaid invoice keeps the row and marks it, rather than deleting
-- it. Two reasons, both practical: the reader can see that the attempt is over
-- instead of the card vanishing mid-glance, and the row's timestamps make the
-- next attempt's idempotency key differ from the abandoned one — without which
-- the provider would replay the cancelled subscription for up to a day and the
-- reader would be handed a QR for an invoice that can never be paid.
create or replace function public.cancel_pending_billing_payment(
  input_user_id uuid,
  input_provider_mode text,
  input_subscription_id text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer;
begin
  if input_user_id is null
     or input_subscription_id is null
     or input_provider_mode not in ('test', 'live') then
    return false;
  end if;

  update public.billing_pending_payments
    set status = 'canceled', updated_at = statement_timestamp()
    where user_id = input_user_id
      and provider_mode = input_provider_mode
      and subscription_id = input_subscription_id
      and status = 'awaiting_payment';

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.cancel_pending_billing_payment(uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. A stored subscription blocks a different one only while it is live
-- ---------------------------------------------------------------------------
--
-- Same signature, same behaviour, one condition corrected.
--
-- The identity guard exists to stop a *second, concurrent* subscription from
-- overwriting the one that is actually being billed — including a stale event
-- for an old subscription arriving after a new one has taken over. Refusing on
-- the identifier alone went further than that: once an account had ever held a
-- subscription, every event for any later one was refused forever, so a reader
-- who cancelled and came back paid and was granted nothing.
--
-- The corrected rule refuses a different identifier only while the stored
-- subscription is still granting access — which is exactly the concurrent case —
-- and on the invoice rail requires the paid period to still be running, because
-- there an `active` status can outlive the period that was actually paid for.
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
  stored_subscription_live boolean;
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

  -- Still being billed, and still granting. On the invoice rail the period is
  -- the authority, because only a paid invoice ever advances it.
  stored_subscription_live := existing.status in ('active', 'past_due')
    and (existing.billing_collection_method is distinct from 'send_invoice'
         or (existing.current_period_end is not null
             and existing.current_period_end > statement_timestamp()));

  failure := null;
  if existing.billing_provider = input_provider
     and existing.billing_provider_mode = 'live'
     and input_provider_mode = 'test' then
    failure := 'provider_mode_downgrade';
  elsif same_provider_identity
     and existing.billing_customer_id is not null
     and existing.billing_customer_id <> input_customer_id then
    failure := 'customer_mismatch';
  elsif same_provider_identity
     and existing.billing_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id
     and stored_subscription_live then
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

  -- Out-of-order delivery, compared on the provider's own clock. Scoped to the
  -- subscription the row already holds: the first event of a *replacement*
  -- subscription is legitimately older than the last event of the one it
  -- replaces, and must not be discarded as stale.
  if same_provider_identity
     and existing.billing_subscription_id is not distinct from input_subscription_id
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
    tier = case when same_provider_identity then coalesce(input_tier, tier) else input_tier end,
    status = input_status,
    billing_provider = input_provider,
    billing_provider_mode = input_provider_mode,
    billing_plan_key = case when same_provider_identity then coalesce(input_plan_key, billing_plan_key) else input_plan_key end,
    billing_interval = case when same_provider_identity then coalesce(input_interval, billing_interval) else input_interval end,
    billing_customer_id = case when same_provider_identity then coalesce(input_customer_id, billing_customer_id) else input_customer_id end,
    billing_subscription_id = case when same_provider_identity then coalesce(input_subscription_id, billing_subscription_id) else input_subscription_id end,
    billing_price_id = case when same_provider_identity then coalesce(input_price_id, billing_price_id) else input_price_id end,
    -- A different subscription brings its own rail and its own period; carrying
    -- either across from the one it replaced would describe a subscription that
    -- no longer exists.
    billing_collection_method = case
      when existing.billing_subscription_id is distinct from input_subscription_id then null
      else billing_collection_method
    end,
    current_period_start = case
      when not same_provider_identity
        or existing.billing_subscription_id is distinct from input_subscription_id
        then input_period_start
      else coalesce(input_period_start, current_period_start)
    end,
    current_period_end = case
      when not same_provider_identity
        or existing.billing_subscription_id is distinct from input_subscription_id
        then input_period_end
      else coalesce(input_period_end, current_period_end)
    end,
    cancel_at_period_end = case when same_provider_identity then coalesce(input_cancel_at_period_end, cancel_at_period_end) else coalesce(input_cancel_at_period_end, false) end,
    latest_invoice_id = case when same_provider_identity then coalesce(input_invoice_id, latest_invoice_id) else input_invoice_id end,
    latest_payment_status = case when same_provider_identity then coalesce(input_payment_status, latest_payment_status) else input_payment_status end,
    latest_payment_at = case
      when input_payment_status is not null then statement_timestamp()
      when same_provider_identity then latest_payment_at
      else null
    end,
    founder_promo_applied = case
      when same_provider_identity then founder_promo_applied or coalesce(input_founder, false)
      else coalesce(input_founder, false)
    end,
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

commit;
