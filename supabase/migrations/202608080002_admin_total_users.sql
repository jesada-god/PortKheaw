begin;

-- ===========================================================================
-- How many accounts exist right now
-- ===========================================================================
--
-- The operator console could say how many accounts were *created* in a window
-- ("สมาชิกใหม่วันนี้ / 7 วัน / 30 วัน") and how many hold each tier, but nothing
-- on it answered the first question anybody asks of a product: how many accounts
-- are there? A tier breakdown cannot be summed into that answer — an account
-- with no `user_subscriptions` row is in no tier, and the three tier counts read
-- a different table from the one that decides whether an account exists at all.
--
-- Three properties this number has to have, and how each is obtained:
--
--   * **It is a count, never a running total.** It is `count(*)` over the live
--     account table at read time. A stored figure incremented on signup and
--     decremented on deletion drifts the first time a write is missed, retried,
--     or rolled back, and nothing about the drift is visible — the console would
--     confidently print a wrong number forever. There is no counter here to get
--     out of step.
--   * **It follows signups and deletions with no extra wiring.** A successful
--     signup is exactly one new `auth.users` row, so the next read is one
--     higher; the deletion pipeline's last act is removing that row (see
--     `202608060002`), so the next read is one lower. Both come free from
--     counting the source of truth rather than being reported to it.
--   * **It ignores the page's date range.** Every other figure here is a window
--     over a period; this one is a statement about the present, so `from_date`
--     and `to_date` are not in its expression at all. Changing the range on the
--     dashboard cannot move it.
--
-- `deleted_at is null` is what makes it "accounts that still exist" rather than
-- "rows in the table". Our own deletion pipeline hard-deletes, so in practice the
-- filter changes nothing today — but GoTrue also offers a soft delete (the
-- Supabase dashboard's own "delete user" can leave the row behind with
-- `deleted_at` stamped), and an account deleted that way must not keep being
-- counted as a user of the product.
--
-- Additive and forward-only. The routine below is dropped and recreated only
-- because adding an output column changes a function's return type, which
-- `create or replace` cannot do. Everything it returned before is returned
-- still, in the same order, with the same expressions, and the new column is
-- appended last — so a caller that reads the old columns by name or by position
-- is unaffected. Its admin gate, its grants and its `security definer` boundary
-- are unchanged: the operator role is still checked inside the database, so the
-- account table is never exposed to a client and no service key is involved in
-- rendering the page.
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
  total_users integer
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
  with membership as (
    select
      public.resolve_effective_subscription_tier(subscription.user_id, observed) as effective_tier,
      subscription.status,
      subscription.trial_ends_at
    from public.user_subscriptions as subscription
  ),
  -- Unchanged from the previous definition, deliberately: "how many signed up in
  -- this window" and "how many accounts exist now" are different questions, and
  -- re-filtering the signup history here would silently move numbers this change
  -- has no business moving.
  signups as (
    select (account.created_at at time zone 'Asia/Bangkok')::date as local_date
    from auth.users as account
  ),
  paid_invoices as (
    select
      invoice.amount_paid_minor,
      invoice.amount_refunded_minor,
      (invoice.paid_at at time zone 'Asia/Bangkok')::date as paid_date
    from public.billing_invoices as invoice
    where invoice.paid_at is not null
      and invoice.status in ('paid', 'refunded', 'partially_refunded', 'disputed')
  )
  select
    (select count(*)::integer from membership where effective_tier = 'basic'),
    (select count(*)::integer from membership where effective_tier = 'pro'),
    (select count(*)::integer from membership where effective_tier = 'elite'),
    (select count(*)::integer from membership
      where status = 'trialing' and trial_ends_at is not null and trial_ends_at > observed),
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
    -- Counted over the whole table on purpose: no date bound, no join, no tier.
    -- Every account that exists at this instant, and nothing else.
    (select count(*)::integer from auth.users as account where account.deleted_at is null);
end;
$$;

revoke all on function public.admin_dashboard_overview(date, date) from public, anon;
grant execute on function public.admin_dashboard_overview(date, date) to authenticated;

commit;
