-- ---------------------------------------------------------------------------
-- A granting status and the period that bounds it are one write, or neither.
-- ---------------------------------------------------------------------------
--
-- The defect this migration closes, found on five production rows reported by
-- reconciliation as `missing-period-end` with `storedStatus: past_due`:
--
-- `gateEntitlementByCollectionMethod` drops the period from a `payment_failed`
-- event on the invoice (PromptPay) rail on purpose — an unpaid invoice may not
-- move a period — and relies on this routine to keep the stored one. But the
-- previous version only kept it when the event named the *same* subscription
-- under the *same* provider identity:
--
--     current_period_end = case
--       when not same_provider_identity
--         or existing.billing_subscription_id is distinct from input_subscription_id
--         then input_period_end                                -- ← NULL, written flat
--       else coalesce(input_period_end, current_period_end)
--     end
--
-- while `status` was written unconditionally from the event. Two columns, two
-- different rules. A reader buying on PromptPay for the first time has no stored
-- subscription id (NULL is distinct from `sub_x`), so a failed first invoice
-- wrote `status = past_due` with `current_period_end = NULL` — and raised `tier`
-- to the plan they never paid for.
--
-- Three changes, all in service of one rule — **a status that grants access is
-- only ever written together with the period that ends it**:
--
--   1. the period is carried as a *pair*, in one branch, whatever else about the
--      event changed. `same_provider_identity` no longer takes part in it.
--   2. a granting status with no period behind it is written as `expired`
--      instead, and `tier` is left where it stood. Nothing half-applied, and
--      nothing raised on the strength of an invoice nobody paid.
--   3. a period the *stored* row holds counts as evidence only when the event is
--      about that same subscription. A period bought on one subscription cannot
--      open a plan on a different one — which is what an unguarded carry-forward
--      would have allowed for a reader whose card subscription was cancelled with
--      time left on it and who then started an unpaid PromptPay purchase.
--
-- Everything else in the routine is unchanged: idempotency, the row lock,
-- identity matching, staleness, and the revocation hold all behave exactly as
-- they did, and are reproduced verbatim below.
--
-- Deliberately *not* a repair of the five rows. This routine stops new ones;
-- the existing ones are corrected by `scripts/backfill-billing-period-end.ts`,
-- which reads the paid invoice behind each row rather than inventing a date.

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
  same_subscription boolean;
  payment_clears_revocation boolean;
  failure text;
  -- The period this write will land, decided once, as a pair.
  carried_period_start timestamptz;
  carried_period_end timestamptz;
  -- Whether that period is evidence for *this* subscription.
  period_is_own boolean;
  -- A granting status asked for with nothing to bound it.
  degraded boolean;
  effective_status text;
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

  same_subscription := existing.billing_subscription_id is not distinct from input_subscription_id;
  /*
   * `coalesce` around the whole expression, and it is load-bearing.
   *
   * `input_payment_status` is NULL on every event that is not an invoice —
   * including `customer.subscription.updated`, which is exactly the event that
   * would otherwise hand access back an hour after a refund. Without the
   * coalesce this is NULL rather than false, `not NULL` is NULL, and the guard
   * below silently does not fire.
   */
  payment_clears_revocation := coalesce(
    input_payment_status = 'succeeded'
      and input_period_end is not null
      and existing.access_revoked_at is not null
      and input_period_end > existing.access_revoked_at,
    false
  );

  if existing.access_revoked_at is not null
     and same_subscription
     and input_status in ('active', 'past_due')
     and not payment_clears_revocation then
    update public.billing_webhook_events
      set status = 'ignored', error_code = 'access_revoked_hold', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'revoked_hold'::text, input_user_id;
    return;
  end if;

  /*
   * The period, decided once and as a pair.
   *
   * An event that carries a period asserts that period, start and end together.
   * An event that carries none — a failed payment or a cancellation on the
   * invoice rail, where only a paid invoice may move a period — leaves the
   * stored pair exactly where it is, whatever else about the event changed.
   * Splitting `start` and `end` across two coalesces could pair one event's
   * start with another's end and trip `user_subscriptions_period_window_check`.
   */
  if input_period_end is not null then
    carried_period_start := input_period_start;
    carried_period_end := input_period_end;
  else
    carried_period_start := existing.current_period_start;
    carried_period_end := existing.current_period_end;
  end if;

  /*
   * Whose period is it.
   *
   * A period that arrived on this event belongs to it by construction. A stored
   * one belongs to this event only when the event is about the same subscription
   * under the same provider identity — otherwise it was bought on something else,
   * and cannot be the thing that keeps a *new* subscription granting.
   */
  period_is_own := input_period_end is not null
    or (same_provider_identity and same_subscription);

  /*
   * A granting status with nothing behind it is not written. `expired` is the
   * honest record: the provider says this subscription is not paid up, and we
   * hold no paid period for it. `tier` stays where it stood, so an invoice
   * nobody paid can never raise it.
   */
  degraded := input_status in ('active', 'past_due')
    and (carried_period_end is null or not period_is_own);
  effective_status := case when degraded then 'expired' else input_status end;

  update public.user_subscriptions
  set
    tier = case
      when degraded then tier
      when same_provider_identity then coalesce(input_tier, tier)
      else input_tier
    end,
    status = effective_status,
    billing_provider = input_provider,
    billing_provider_mode = input_provider_mode,
    billing_plan_key = case when same_provider_identity then coalesce(input_plan_key, billing_plan_key) else input_plan_key end,
    billing_interval = case when same_provider_identity then coalesce(input_interval, billing_interval) else input_interval end,
    billing_customer_id = case when same_provider_identity then coalesce(input_customer_id, billing_customer_id) else input_customer_id end,
    billing_subscription_id = case when same_provider_identity then coalesce(input_subscription_id, billing_subscription_id) else input_subscription_id end,
    billing_price_id = case when same_provider_identity then coalesce(input_price_id, billing_price_id) else input_price_id end,
    billing_collection_method = case
      when existing.billing_subscription_id is distinct from input_subscription_id then null
      else billing_collection_method
    end,
    -- One decision, one pair, no second rule. See above.
    current_period_start = carried_period_start,
    current_period_end = carried_period_end,
    cancel_at_period_end = case when same_provider_identity then coalesce(input_cancel_at_period_end, cancel_at_period_end) else coalesce(input_cancel_at_period_end, false) end,
    latest_invoice_id = case when same_provider_identity then coalesce(input_invoice_id, latest_invoice_id) else input_invoice_id end,
    latest_payment_status = case when same_provider_identity then coalesce(input_payment_status, latest_payment_status) else input_payment_status end,
    latest_payment_at = case
      when input_payment_status is not null then statement_timestamp()
      when same_provider_identity then latest_payment_at
      else null
    end,
    -- A degraded write granted nothing, so it may not spend the founder slot.
    founder_promo_applied = case
      when degraded then founder_promo_applied
      when same_provider_identity then founder_promo_applied or coalesce(input_founder, false)
      else coalesce(input_founder, false)
    end,
    -- Money, or a different purchase entirely, is what lifts a revocation.
    access_revoked_at = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_at
    end,
    access_revoked_reason = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_reason
    end,
    access_revoked_restore_status = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_restore_status
    end,
    provider_event_at = input_occurred_at,
    provider_event_id = input_event_id
  where user_id = input_user_id;

  /*
   * Still `applied` — the write happened and the provider must not retry it —
   * with the degrade recorded on the audit row so an operator can tell a
   * downgraded write from an ordinary one without reading the provider's
   * dashboard.
   */
  update public.billing_webhook_events
    set status = 'applied',
        error_code = case when degraded then 'period_incomplete' else error_code end,
        processed_at = statement_timestamp()
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

-- ---------------------------------------------------------------------------
-- The same rule, as a constraint
-- ---------------------------------------------------------------------------
--
-- The routine above is the only writer that can produce a granting status, and
-- it can no longer produce one without a period. This is the belt to that
-- braces: any future path — a routine added later, a hand-run UPDATE during an
-- incident — is refused by the database rather than discovered by reconciliation
-- five rows later.
--
-- `trialing` is deliberately outside the constraint: the Elite trial is bounded
-- by `trial_ends_at`, not by a billing period, and `resolveEffectiveTier` reads
-- it from there.
--
-- **NOT VALID on purpose.** Five rows in production already violate it. NOT
-- VALID enforces the rule on every insert and update from this moment while
-- leaving the existing rows readable, so the constraint can ship before the
-- backfill instead of waiting for it. `202608240001` validates it afterwards.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_granting_status_period_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_granting_status_period_check
      check (status not in ('active', 'past_due') or current_period_end is not null)
      not valid;
  end if;
end;
$$;
