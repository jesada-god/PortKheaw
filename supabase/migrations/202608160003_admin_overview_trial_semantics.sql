begin;

-- ===========================================================================
-- One person, counted once, in the card that describes them
-- ===========================================================================
--
-- The overview's user figures were each defensible on their own and could not be
-- read together. An account holding a live Elite trial was counted by *two* of
-- them: `trial_members` saw a running trial, and `elite_members` saw what
-- `resolve_effective_subscription_tier` answers for a running trial — which is
-- 'elite', because a trial grants the Elite product. Both numbers were true
-- statements about one person, and the row of cards read as two people, one of
-- whom had paid. When that trial lapsed the same person moved silently into
-- `basic_members`, so the console reported a Basic member who had never been one.
--
-- Nothing about entitlement is changed to fix that. `resolve_effective_subscription_tier`
-- is still the only thing that decides what an account may open, it is still
-- called here, and its answer for a trial is still Elite — a trial user really
-- does hold the Elite product, and a gate that said otherwise would take the
-- product away. What changes is the *bucket the console puts them in*: an account
-- whose trial is running now is reported under "กำลังทดลองใช้" and nowhere else,
-- and the tier cards report the accounts whose tier comes from a subscription
-- rather than from a trial. That is a presentation rule, and it lives here rather
-- than in the resolver so that no gate anywhere can be moved by it.
--
-- Three further properties the user figures now have:
--
--   * **They are counted per account, over the accounts that exist.** The scan
--     starts at `auth.users` (minus GoTrue's soft-deleted rows) and left joins
--     the subscription, rather than starting at `user_subscriptions`. An account
--     with no subscription row was previously in no card at all; it is Basic now,
--     which is exactly what it can open. `user_subscriptions.user_id` is the
--     primary key, so the join cannot duplicate anybody. The five current-state
--     figures therefore sum to `total_users` — the console can be added up, and
--     an operator who adds it up is right.
--
--   * **"Active trial" is decided by the database clock, every read.** The
--     predicate is `status = 'trialing' and trial_started_at <= now and
--     trial_ends_at > now`, evaluated against `statement_timestamp()`. There is
--     no stored "is trialing" flag to go stale, no job that has to run for the
--     number to fall, and no browser clock involved: the moment a trial's end
--     passes, the next read of this routine returns one fewer. A trial stamped to
--     start in the future — which no grant path produces, but a repair script
--     could — is not counted as running today.
--
--   * **Nothing is deleted to make them move.** `trial_identity_claims` is the
--     record that a free week has been spent, and it deliberately outlives both
--     the trial and the account (`202608060002`). An expired trial leaves that
--     row, `trial_used_at`, `trial_started_at` and `trial_ends_at` exactly where
--     they are; it stops being counted as *current* because the count asks a
--     question about now, and that is the only mechanism involved.
--
-- Two figures are appended, so that "how many are on a trial" has the movement
-- figure it is read against — a current count alone cannot say whether trials are
-- being started or whether anybody converts:
--
--   * `trial_starts_7d` — accounts whose trial began in the last seven Bangkok
--     days, from `trial_started_at`, the column the grant itself writes. Expired
--     trials are included; it is a historical figure and excluding them would
--     make it a second, worse copy of the current count.
--   * `paid_conversions_7d` — accounts whose *first* settled invoice fell in the
--     same window, from the same `billing_invoices` rows the revenue cards are
--     made of. First payment is what "became a paying customer" means; a renewal
--     is the same customer paying again, and counting it would turn a conversion
--     figure into a payment figure.
--
-- Both windows are the trailing seven Bangkok days, the same window
-- `new_members_7d` already used, so the three period figures on the page can be
-- read as one story. Neither is bounded by the page's date range, and neither is
-- any current-state figure: the range governs the revenue cards, which is what it
-- has always governed.
--
-- Additive and forward-only. No table, column, row, policy, grant or trigger is
-- touched. The routine is dropped and recreated only because appending an output
-- column changes a function's return type, which `create or replace` cannot do;
-- every column it returned before is returned still, in the same order, and the
-- two new ones are appended last. Its admin gate, its grants and its
-- `security definer` boundary are unchanged.
drop function if exists public.admin_dashboard_overview(date, date);

create function public.admin_dashboard_overview(
  input_from_date date,
  input_to_date date
)
returns table (
  basic_members integer,
  pro_members integer,
  elite_members integer,
  trial_members integer,
  promptpay_pending integer,
  past_due_members integer,
  new_members_today integer,
  new_members_7d integer,
  new_members_30d integer,
  revenue_today_minor bigint,
  revenue_month_minor bigint,
  revenue_period_minor bigint,
  refunds_period_minor bigint,
  failed_webhooks integer,
  dead_letter_webhooks integer,
  open_reconciliation_issues integer,
  critical_reconciliation_issues integer,
  open_tickets integer,
  open_refund_requests integer,
  period_from date,
  period_to date,
  database_now timestamptz,
  total_users integer,
  trial_starts_7d integer,
  paid_conversions_7d integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  observed timestamptz := statement_timestamp();
  today date := (observed at time zone 'Asia/Bangkok')::date;
  from_date date;
  to_date date;
  swap date;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  from_date := coalesce(input_from_date, today - 29);
  to_date := coalesce(input_to_date, today);
  if from_date > to_date then
    -- A reversed range is corrected rather than refused. It is a UI slip, and an
    -- empty dashboard would read as "no revenue" rather than "bad input".
    swap := from_date;
    from_date := to_date;
    to_date := swap;
  end if;

  return query
  -- The account table is read once and feeds both the signup history and the
  -- current-state figures below, rather than being scanned separately for each.
  with account as (
    select
      users.id as user_id,
      users.deleted_at,
      (users.created_at at time zone 'Asia/Bangkok')::date as signup_date
    from auth.users as users
  ),
  -- One row per account that exists, holding everything the five current-state
  -- cards are decided by. `user_subscriptions.user_id` is its primary key, so
  -- this join adds no rows and nobody can be counted twice.
  membership as (
    select
      account.user_id,
      subscription.status,
      -- The whole definition of "กำลังทดลองใช้", in one place: a trial that has
      -- begun and has not ended, against the database clock at read time.
      (
        subscription.status = 'trialing'
        and subscription.trial_ends_at is not null
        and subscription.trial_ends_at > observed
        and (subscription.trial_started_at is null or subscription.trial_started_at <= observed)
      ) as trial_active,
      -- The same resolver every gate reads. It answers 'elite' for a running
      -- trial; the counts below are where that answer is put in the trial
      -- bucket instead of the Elite one, so no entitlement is altered.
      public.resolve_effective_subscription_tier(account.user_id, observed) as effective_tier,
      (subscription.trial_started_at at time zone 'Asia/Bangkok')::date as trial_start_date
    from account
    left join public.user_subscriptions as subscription
      on subscription.user_id = account.user_id
    where account.deleted_at is null
  ),
  -- Unchanged, deliberately: "how many signed up in this window" is a question
  -- about the past, and re-filtering it here would move a number this change has
  -- no business moving.
  signups as (
    select account.signup_date as local_date from account
  ),
  paid_invoices as (
    select
      invoice.user_id,
      invoice.amount_paid_minor,
      invoice.amount_refunded_minor,
      invoice.paid_at,
      (invoice.paid_at at time zone 'Asia/Bangkok')::date as paid_date
    from public.billing_invoices as invoice
    where invoice.paid_at is not null
      and invoice.status in ('paid', 'refunded', 'partially_refunded', 'disputed')
  ),
  -- When each account first paid us anything. `amount_paid_minor > 0` is what
  -- keeps a zero-value settled invoice — a full discount, a credited renewal —
  -- from reading as the moment somebody became a paying customer.
  first_payments as (
    select paid_invoices.user_id, min(paid_invoices.paid_at) as first_paid_at
    from paid_invoices
    where paid_invoices.amount_paid_minor > 0
    group by paid_invoices.user_id
  )
  select
    -- An account with no subscription row lands here, because Basic is what it
    -- can open. `not trial_active` is what keeps the trial user out of the tier
    -- they are trialling.
    (select count(*)::integer from membership
      where not trial_active and effective_tier = 'basic'),
    (select count(*)::integer from membership
      where not trial_active and effective_tier = 'pro'),
    (select count(*)::integer from membership
      where not trial_active and effective_tier = 'elite'),
    (select count(*)::integer from membership where trial_active),
    (select count(*)::integer from public.billing_pending_payments as pending
      where pending.status = 'awaiting_payment'
        and (pending.due_at is null or pending.due_at > observed)),
    (select count(*)::integer from membership where status = 'past_due'),
    (select count(*)::integer from signups where local_date = today),
    (select count(*)::integer from signups where local_date > today - 7),
    (select count(*)::integer from signups where local_date > today - 30),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date = today),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date >= date_trunc('month', today)::date and paid_date <= today),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date between from_date and to_date),
    (select coalesce(sum(amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date between from_date and to_date),
    (select count(*)::integer from public.billing_webhook_retries where status = 'retrying'),
    (select count(*)::integer from public.billing_webhook_retries where status = 'dead_letter'),
    (select count(*)::integer from public.billing_reconciliation_issues where resolved_at is null),
    (select count(*)::integer from public.billing_reconciliation_issues
      where resolved_at is null and severity = 'critical'),
    (select count(*)::integer from public.support_tickets where status in ('open', 'in_progress')),
    (select count(*)::integer from public.refund_requests
      where status in ('pending', 'reviewing', 'approved')),
    from_date,
    to_date,
    observed,
    -- Every account that exists at this instant, and nothing else. No date bound,
    -- no join, no tier — and now the sum of the five figures above it.
    (select count(*)::integer from account where account.deleted_at is null),
    -- Trials that *began* in the window, whether or not they are still running.
    (select count(*)::integer from membership
      where trial_start_date is not null
        and trial_start_date > today - 7
        and trial_start_date <= today),
    (select count(*)::integer from first_payments
      where (first_paid_at at time zone 'Asia/Bangkok')::date > today - 7
        and (first_paid_at at time zone 'Asia/Bangkok')::date <= today);
end;
$$;

revoke all on function public.admin_dashboard_overview(date, date) from public, anon;
grant execute on function public.admin_dashboard_overview(date, date) to authenticated;

commit;
