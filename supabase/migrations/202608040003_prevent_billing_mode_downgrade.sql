begin;

-- Harden the mode-scoped writer after the initial Phase 4.2 migration. A live
-- identity is authoritative and can never be replaced by a later test event.
-- Moving from test/legacy to live is allowed for the controlled launch, but all
-- mode-local state is replaced rather than carried across that boundary.
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
    tier = case when same_provider_identity then coalesce(input_tier, tier) else input_tier end,
    status = input_status,
    billing_provider = input_provider,
    billing_provider_mode = input_provider_mode,
    billing_plan_key = case when same_provider_identity then coalesce(input_plan_key, billing_plan_key) else input_plan_key end,
    billing_interval = case when same_provider_identity then coalesce(input_interval, billing_interval) else input_interval end,
    billing_customer_id = case when same_provider_identity then coalesce(input_customer_id, billing_customer_id) else input_customer_id end,
    billing_subscription_id = case when same_provider_identity then coalesce(input_subscription_id, billing_subscription_id) else input_subscription_id end,
    billing_price_id = case when same_provider_identity then coalesce(input_price_id, billing_price_id) else input_price_id end,
    current_period_start = case when same_provider_identity then coalesce(input_period_start, current_period_start) else input_period_start end,
    current_period_end = case when same_provider_identity then coalesce(input_period_end, current_period_end) else input_period_end end,
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
