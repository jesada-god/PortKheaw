begin;

-- ===========================================================================
-- "กำลังทดลองใช้ 0" — the two figures that say which zero it is
-- ===========================================================================
--
-- `202608160003` made the trial card mean one thing: an account whose trial is
-- running at read time, counted there and nowhere else. That count is right, and
-- it is unreadable on its own. Zero is returned both by a product whose free week
-- nobody has ever taken and by a product whose trials all ended last Tuesday, and
-- an operator looking at the card cannot tell those apart — so the honest number
-- reads as a broken one, and the first thing anybody does with a number they
-- believe is broken is stop trusting the page it is on.
--
-- The current-state cards cannot answer it themselves. They report where every
-- account *is now*, they sum to `total_users`, and that invariant is the reason
-- the row can be added up; a lapsed trial belongs under Basic, because Basic is
-- what that account can open. Nothing here moves anybody between cards. Two
-- figures are appended instead, both about the trial's history rather than its
-- present, and the console shows them under the group rather than beside it:
--
--   * `trial_starts_total` — accounts that have ever started the free week, at
--     any time, whatever became of it. It is `trial_starts_7d` with the window
--     taken off, and it is the figure that answers "does the trial work at all":
--     zero here means no account has ever been granted one, which is a defect to
--     go and find; anything above zero means the grant path works and the current
--     count is simply describing today.
--
--   * `expired_trial_members` — accounts whose trial has ended and who are
--     reported under Basic now. It is a strict subset of `basic_members`, which
--     is exactly what makes it safe to show: it explains part of a card without
--     competing with it, and adding it to the row would break the sum. This is
--     where the people who were on a trial went.
--
-- Both are read from `trial_started_at` and `trial_ends_at` — the columns the
-- grant itself writes and that `202608060002` guarantees outlive the trial and
-- the account. Nothing is stored, no job has to run, and no row is written to
-- produce either number.
--
-- The second half of this migration is the same question asked about one person.
-- `admin_search_accounts` returns the subscription row as stored, so an account
-- whose week ended three days ago is still described to the operator as
-- `trialing · elite` while the chip beside it says the account can only open
-- Basic. Both statements are true — the row really does still say `trialing`,
-- because a lapsed trial is not rewritten — and read together they look like a
-- contradiction the operator has to resolve by hand. The trial's own dates are
-- appended so the console can say which it is, and `trial_active` is appended
-- with them so the page never has to re-derive the rule from the dates.
--
-- That rule now has one home. `subscription_trial_is_active` is the predicate
-- `202608160003` wrote inline, lifted out so the overview and the account search
-- cannot drift apart. It is deliberately *not* used by
-- `resolve_effective_subscription_tier`: the resolver answers what an account may
-- open and a trial grants the Elite product, which is a different question with a
-- different answer, and folding the two together is how a reporting change would
-- become an entitlement change. No gate is touched by this migration.
--
-- Additive and forward-only. No table, column, row, policy or trigger is
-- touched. Both routines are dropped and recreated only because appending output
-- columns changes a function's return type, which `create or replace` cannot do;
-- every column each returned before is returned still, in the same order, and the
-- new ones are appended last. Their admin gates, their grants and their
-- `security definer` boundaries are unchanged.

-- ---------------------------------------------------------------------------
-- 1. One definition of "the trial is running"
-- ---------------------------------------------------------------------------
--
-- A trial that has begun and has not ended, against a clock the caller passes in
-- so that every figure on one page is decided at one instant. `stable` rather
-- than `immutable` for the same reason it takes `as_of` at all: the answer is
-- about a moment, and the moment is an argument rather than something read here.
create or replace function public.subscription_trial_is_active(
  input_status text,
  input_trial_started_at timestamptz,
  input_trial_ends_at timestamptz,
  input_as_of timestamptz
)
returns boolean
language sql
stable
security invoker set search_path = ''
as $$
  select
    input_status = 'trialing'
    and input_trial_ends_at is not null
    and input_trial_ends_at > input_as_of
    -- A trial stamped to begin in the future is not running today. No grant path
    -- produces one; a repair script could.
    and (input_trial_started_at is null or input_trial_started_at <= input_as_of)
$$;

comment on function public.subscription_trial_is_active(text, timestamptz, timestamptz, timestamptz)
  is 'Whether a subscription row describes a trial that is running at input_as_of. Reporting only: entitlement is resolve_effective_subscription_tier.';

-- Readable by anything that can already read a subscription row. It answers a
-- question about values the caller handed it and touches no table, so it grants
-- nothing on its own.
grant execute on function public.subscription_trial_is_active(text, timestamptz, timestamptz, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The overview, with the trial's history beside its present
-- ---------------------------------------------------------------------------
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
  paid_conversions_7d integer,
  trial_starts_total integer,
  expired_trial_members integer
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
      public.subscription_trial_is_active(
        subscription.status,
        subscription.trial_started_at,
        subscription.trial_ends_at,
        observed
      ) as trial_active,
      -- The same resolver every gate reads. It answers 'elite' for a running
      -- trial; the counts below are where that answer is put in the trial
      -- bucket instead of the Elite one, so no entitlement is altered.
      public.resolve_effective_subscription_tier(account.user_id, observed) as effective_tier,
      subscription.trial_started_at,
      subscription.trial_ends_at,
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
        and (first_paid_at at time zone 'Asia/Bangkok')::date <= today),
    -- Every free week ever granted to an account that still exists, whatever
    -- became of it afterwards. Unbounded on purpose: this is the figure that
    -- separates "no trial is running today" from "no trial has ever run".
    (select count(*)::integer from membership where trial_started_at is not null),
    -- The lapsed trials, where they are now. Strictly inside `basic_members`:
    -- an account that bought a plan after its week is reported by the tier it
    -- bought, and one whose trial is still running is not lapsed.
    (select count(*)::integer from membership
      where trial_ends_at is not null
        and trial_ends_at <= observed
        and effective_tier = 'basic');
end;
$$;

revoke all on function public.admin_dashboard_overview(date, date) from public, anon;
grant execute on function public.admin_dashboard_overview(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. One account, with its trial described rather than implied
-- ---------------------------------------------------------------------------
--
-- `status` and `tier` are still returned exactly as stored — the console's
-- "สถานะ" row is a window onto the row, and quietly rewriting `trialing` into
-- something more comfortable would hide the fact that the row says it. The dates
-- are what let the page finish the sentence.
drop function if exists public.admin_search_accounts(text, integer);

create function public.admin_search_accounts(input_query text, input_limit integer)
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  tier text,
  status text,
  effective_tier text,
  billing_plan_key text,
  billing_interval text,
  billing_provider_mode text,
  billing_collection_method text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  access_revoked_at timestamptz,
  access_revoked_reason text,
  open_ticket_count bigint,
  open_refund_count bigint,
  database_now timestamptz,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_active boolean
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  needle text := btrim(coalesce(input_query, ''));
  row_limit integer := least(greatest(coalesce(input_limit, 20), 1), 50);
  observed timestamptz := statement_timestamp();
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    account.id,
    -- The cast is not decoration. `auth.users.email` is varchar(255) upstream,
    -- and a set-returning function will not widen it to `text` on its own —
    -- without it every search fails with 42804. See `202608050006`.
    account.email::text,
    profile.full_name::text,
    coalesce(roles.role, 'user')::text,
    coalesce(subscription.tier, 'basic')::text,
    coalesce(subscription.status, 'basic')::text,
    public.resolve_effective_subscription_tier(account.id, observed)::text,
    subscription.billing_plan_key::text,
    subscription.billing_interval::text,
    subscription.billing_provider_mode::text,
    subscription.billing_collection_method::text,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end, false),
    subscription.access_revoked_at,
    subscription.access_revoked_reason::text,
    (select count(*) from public.support_tickets as ticket
      where ticket.user_id = account.id and ticket.status <> 'closed'),
    (select count(*) from public.refund_requests as request
      where request.user_id = account.id
        and request.status in ('pending', 'reviewing', 'approved')),
    observed,
    subscription.trial_started_at,
    subscription.trial_ends_at,
    -- The same predicate the overview counts with, so one account read here and
    -- the card that counts it can never disagree.
    coalesce(
      public.subscription_trial_is_active(
        subscription.status,
        subscription.trial_started_at,
        subscription.trial_ends_at,
        observed
      ),
      false
    )
  from auth.users as account
  left join public.profiles as profile on profile.id = account.id
  left join public.user_roles as roles on roles.user_id = account.id
  left join public.user_subscriptions as subscription on subscription.user_id = account.id
  where needle <> '' and (
    account.email::text ilike '%' || needle || '%'
    or profile.full_name ilike '%' || needle || '%'
    or account.id::text = needle
  )
  order by account.created_at desc
  limit row_limit;
end;
$$;

revoke all on function public.admin_search_accounts(text, integer) from public, anon;
grant execute on function public.admin_search_accounts(text, integer) to authenticated;

commit;
