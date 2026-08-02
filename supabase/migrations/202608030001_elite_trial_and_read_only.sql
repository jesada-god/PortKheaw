begin;

-- Phase 2 builds on the Phase 1 entitlement foundation without altering it. It
-- adds one trusted way to start the seven-day Elite trial, and it closes the
-- write paths that a Basic subscription must not reach once that trial ends.
-- Nothing here deletes a portfolio, a transaction, or any other user data.

-- The one stock portfolio a Basic subscription may still write to: the oldest
-- active one, ordered by (created_at, id) so the answer never depends on join
-- order and never changes on its own. Deriving the choice on read is what keeps
-- a downgrade from having to mark, move, or archive anything permanently.
create or replace function public.basic_writable_stock_portfolio(input_user_id uuid)
returns uuid
language sql
stable
security definer set search_path = ''
as $$
  select portfolio.id
  from public.portfolios as portfolio
  where portfolio.user_id = input_user_id
    and portfolio.portfolio_type = 'STOCK'
    and portfolio.archived_at is null
  order by portfolio.created_at, portfolio.id
  limit 1
$$;

revoke all on function public.basic_writable_stock_portfolio(uuid) from public, anon, authenticated;

-- The single write gate for portfolio-scoped mutations. Every caller is a
-- SECURITY DEFINER routine, and the portfolio tables themselves have INSERT,
-- UPDATE and DELETE revoked from `authenticated`, so there is no path around it.
--
-- Reads are never gated here: an over-limit portfolio stays fully visible.
create or replace function public.assert_portfolio_writable(target_portfolio uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  owner_id uuid;
  portfolio_kind text;
  effective_tier text;
begin
  select portfolio.user_id, portfolio.portfolio_type
    into owner_id, portfolio_kind
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio
    and portfolio.user_id = (select auth.uid());
  if owner_id is null then
    raise exception 'Portfolio not found' using errcode = '42501';
  end if;

  effective_tier := public.resolve_effective_subscription_tier(owner_id, statement_timestamp());
  if effective_tier <> 'basic' then
    return;
  end if;

  -- Options are not a Basic capability at all, so the answer is "upgrade",
  -- never "you are over a limit".
  if portfolio_kind = 'OPTION' then
    raise exception 'UPGRADE_REQUIRED:portfolio.options.write' using errcode = 'P0001';
  end if;

  -- The LEGACY portfolio never counts against the Basic limit, so it is always
  -- writable. Extra stock portfolios kept from a paid period or an expired
  -- trial stay readable and become read-only.
  if portfolio_kind = 'STOCK'
    and target_portfolio is distinct from public.basic_writable_stock_portfolio(owner_id)
  then
    raise exception 'READ_ONLY_SUBSCRIPTION:portfolio.stock.write' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_portfolio_writable(uuid) from public, anon, authenticated;

-- Ledger writes already funnel through this assertion, which makes it the
-- chokepoint for creating and editing transactions and for option sell targets.
-- Only the entitlement check is added; the ownership, archive and
-- portfolio-type rules below it are unchanged from the multi-portfolio release.
create or replace function public.assert_portfolio_accepts_transaction(
  target_portfolio uuid, input_type text, require_active boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare owned_portfolio public.portfolios%rowtype;
begin
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio and portfolio.user_id = (select auth.uid())
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio);
  if require_active and owned_portfolio.archived_at is not null then
    raise exception 'Archived portfolio cannot receive new transactions' using errcode = '23514';
  end if;
  if owned_portfolio.portfolio_type = 'STOCK' and input_type not in (
    'acquisition', 'disposal', 'initial_position', 'dividend',
    'deposit', 'withdrawal', 'fee', 'adjustment', 'transfer_out', 'transfer_in'
  ) then
    raise exception 'Stock portfolio does not accept option transactions' using errcode = '23514';
  end if;
  if owned_portfolio.portfolio_type = 'OPTION' and input_type not in (
    'deposit', 'withdrawal', 'fee', 'adjustment', 'transfer_out', 'transfer_in',
    'buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close',
    'exercise', 'assignment', 'expired'
  ) then
    raise exception 'Option portfolio does not accept stock transactions' using errcode = '23514';
  end if;
end;
$$;
revoke all on function public.assert_portfolio_accepts_transaction(uuid,text,boolean) from public, anon, authenticated;

-- Deleting a transaction does not pass through the assertion above, so it is
-- gated directly.
create or replace function public.delete_portfolio_ledger_transaction(transaction_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid;
begin
  select transaction.portfolio_id into target_portfolio
  from public.portfolio_transactions as transaction
  join public.portfolios as portfolio on portfolio.id = transaction.portfolio_id
  where transaction.id = transaction_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio);
  if exists (select 1 from public.portfolio_transactions where id = transaction_id and transfer_id is not null) then
    raise exception 'Paired transfers cannot be deleted as standalone transactions' using errcode = '23514';
  end if;
  perform 1 from public.portfolios where id = target_portfolio for update;
  delete from public.portfolio_transactions where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

-- A transfer writes a paired row into two portfolios, so both ends must be
-- writable. Gating only the source would let cash flow into a read-only
-- portfolio.
create or replace function public.transfer_portfolio_cash(
  source_portfolio_id uuid, destination_portfolio_id uuid, input_amount_usd numeric,
  input_occurred_at timestamptz, input_note text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare requesting_user uuid := (select auth.uid()); transfer_key uuid := input_idempotency_key;
begin
  if source_portfolio_id = destination_portfolio_id then raise exception 'Transfer portfolios must differ' using errcode = '22023'; end if;
  if input_amount_usd <= 0 then raise exception 'Transfer amount must be greater than zero' using errcode = '22023'; end if;
  perform 1 from public.portfolios
  where id in (source_portfolio_id, destination_portfolio_id)
    and user_id = requesting_user and archived_at is null
  order by id for update;
  if (select count(*) from public.portfolios
      where id in (source_portfolio_id, destination_portfolio_id)
        and user_id = requesting_user and archived_at is null) <> 2 then
    raise exception 'Transfer portfolios not found or archived' using errcode = '42501';
  end if;
  perform public.assert_portfolio_writable(source_portfolio_id);
  perform public.assert_portfolio_writable(destination_portfolio_id);
  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, amount, original_amount, original_currency,
    normalized_amount_usd, occurred_at, occurred_at_time, note, idempotency_key,
    transfer_id, counterparty_portfolio_id
  ) values (
    source_portfolio_id, 'transfer_out', input_amount_usd, input_amount_usd, 'USD',
    input_amount_usd, (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at, nullif(btrim(input_note), ''), input_idempotency_key,
    transfer_key, destination_portfolio_id
  ) on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;
  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, amount, original_amount, original_currency,
    normalized_amount_usd, occurred_at, occurred_at_time, note, idempotency_key,
    transfer_id, counterparty_portfolio_id
  ) values (
    destination_portfolio_id, 'transfer_in', input_amount_usd, input_amount_usd, 'USD',
    input_amount_usd, (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at, nullif(btrim(input_note), ''), input_idempotency_key,
    transfer_key, source_portfolio_id
  ) on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;
  return transfer_key;
end;
$$;

create or replace function public.update_portfolio_details(
  target_portfolio_id uuid, input_name text, input_type text
) returns void language plpgsql security definer set search_path = '' as $$
declare owned_portfolio public.portfolios%rowtype; normalized_name text := btrim(input_name);
begin
  if input_type not in ('STOCK', 'OPTION', 'LEGACY') then raise exception 'Unsupported portfolio type' using errcode = '22023'; end if;
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = (select auth.uid())
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio_id);
  if not (char_length(normalized_name) between 1 and (case when owned_portfolio.is_legacy then 80 else 40 end)) then
    raise exception 'Portfolio name must contain 1-40 characters' using errcode = '22023';
  end if;
  if owned_portfolio.is_legacy and input_type <> 'LEGACY' then
    raise exception 'Legacy portfolio type cannot be changed' using errcode = '23514';
  end if;
  if not owned_portfolio.is_legacy and input_type = 'LEGACY' then
    raise exception 'Portfolio cannot be converted to legacy' using errcode = '23514';
  end if;
  if input_type <> owned_portfolio.portfolio_type and exists (
    select 1 from public.portfolio_transactions as transaction
    where transaction.portfolio_id = owned_portfolio.id
  ) then
    raise exception 'Portfolio type cannot change after transactions exist' using errcode = '23514';
  end if;
  update public.portfolios
  set name = normalized_name, portfolio_type = input_type, updated_at = now()
  where id = owned_portfolio.id;
end;
$$;

create or replace function public.set_portfolio_goal(
  target_portfolio_id uuid, input_target_value_usd numeric, input_target_date date
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if input_target_value_usd is not null and input_target_value_usd <= 0 then
    raise exception 'Target value must be greater than zero' using errcode = '22023';
  end if;
  if input_target_value_usd is null and input_target_date is not null then
    raise exception 'Target date requires a target value' using errcode = '22023';
  end if;
  perform public.assert_portfolio_writable(target_portfolio_id);
  update public.portfolios
  set target_value_usd = input_target_value_usd,
      target_date = case when input_target_value_usd is null then null else input_target_date end,
      updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid());
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.delete_empty_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owned_portfolio public.portfolios%rowtype; derived_cash numeric(28,8);
begin
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = (select auth.uid())
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio_id);
  if owned_portfolio.is_legacy then raise exception 'Legacy portfolio cannot be deleted' using errcode = '23514'; end if;
  if owned_portfolio.target_value_usd is not null or exists (
    select 1 from public.portfolio_option_targets as target where target.portfolio_id = owned_portfolio.id
  ) or exists (
    select 1 from public.portfolio_option_positions as position where position.portfolio_id = owned_portfolio.id
  ) then
    raise exception 'Portfolio targets or positions must be cleared before deletion' using errcode = '23514';
  end if;
  select coalesce(sum(case
    when transaction_type in ('deposit', 'dividend', 'adjustment', 'transfer_in') then normalized_amount_usd
    when transaction_type in ('withdrawal', 'fee', 'transfer_out') then -normalized_amount_usd
    else 0
  end), 0) into derived_cash
  from public.portfolio_transactions
  where portfolio_id = owned_portfolio.id;
  if derived_cash <> 0 or exists (
    select 1 from public.portfolio_transactions as transaction
    where transaction.portfolio_id = owned_portfolio.id
  ) then
    raise exception 'Portfolio with ledger history must be archived, not deleted' using errcode = '23514';
  end if;
  delete from public.portfolios where id = owned_portfolio.id;
end;
$$;

-- Resolving the owning portfolio first is what makes this gateable; the delete
-- itself keeps the same ownership predicate it had before.
create or replace function public.delete_portfolio_option_target(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid;
begin
  select target.portfolio_id into target_portfolio
  from public.portfolio_option_targets as target
  join public.portfolios as portfolio on portfolio.id = target.portfolio_id
  where target.id = target_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Option target not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio);
  delete from public.portfolio_option_targets where id = target_id and portfolio_id = target_portfolio;
end;
$$;

-- `archive_portfolio` and `restore_portfolio` deliberately keep no write gate.
-- Archiving is the escape hatch a downgraded reader needs to put an extra
-- portfolio away without losing it, and restoring is already bounded by the
-- tier-aware limit trigger from the entitlement foundation, which answers
-- LIMIT_REACHED when a restore would exceed the Basic allowance.

-- The seven-day Elite trial. Every fact it decides on is read inside the
-- database: the caller's identity from auth.uid(), mailbox proof from
-- auth.users, the current subscription from a locked row, and the clock from
-- now(). No argument is accepted, so a client cannot name a user, a tier, a
-- status or a time.
create or replace function public.start_elite_trial()
returns table (
  user_id uuid,
  tier text,
  status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  database_now timestamptz
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  mailbox_confirmed_at timestamptz;
  subscription public.user_subscriptions%rowtype;
  granted_at timestamptz := now();
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select users.email_confirmed_at into mailbox_confirmed_at
  from auth.users as users
  where users.id = requesting_user;
  if mailbox_confirmed_at is null then
    raise exception 'EMAIL_NOT_VERIFIED' using errcode = 'P0001';
  end if;

  -- FOR UPDATE serializes concurrent attempts on one account. The second
  -- transaction re-reads this row after the first commits, so it observes the
  -- trial that was just granted rather than the state it started from.
  select * into subscription
  from public.user_subscriptions as current_row
  where current_row.user_id = requesting_user
  for update;
  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if subscription.status = 'active'
    and subscription.tier in ('pro', 'elite')
    and subscription.current_period_end is not null
    and subscription.current_period_end > granted_at
  then
    raise exception 'PAID_SUBSCRIPTION_ACTIVE' using errcode = 'P0001';
  end if;

  if subscription.status = 'trialing'
    and subscription.trial_ends_at is not null
    and subscription.trial_ends_at > granted_at
  then
    raise exception 'TRIAL_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;

  if subscription.trial_used_at is not null then
    raise exception 'TRIAL_ALREADY_USED' using errcode = 'P0001';
  end if;

  update public.user_subscriptions as target
  set tier = 'elite',
      status = 'trialing',
      trial_started_at = granted_at,
      trial_ends_at = granted_at + interval '7 days',
      trial_used_at = granted_at
  where target.user_id = requesting_user;

  -- Billing identifiers are never part of this projection.
  return query
  select
    target.user_id,
    target.tier,
    target.status,
    target.trial_started_at,
    target.trial_ends_at,
    target.trial_used_at,
    statement_timestamp()
  from public.user_subscriptions as target
  where target.user_id = requesting_user;
end;
$$;

revoke all on function public.start_elite_trial() from public, anon;
grant execute on function public.start_elite_trial() to authenticated;

commit;
