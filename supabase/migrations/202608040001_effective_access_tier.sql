begin;

-- Phase 3.2 — one effective access tier, read by every gate.
--
-- Phases 1–3 left the product judging a reader by two different values. The
-- application resolved `effectiveAccessTier` (subscription, plus the operator
-- role and any running access preview) and gated pages and API routes on it,
-- while the database gated portfolio writes on
-- `resolve_effective_subscription_tier` — the plan alone. An administrator whose
-- stored plan is Basic could therefore open Options everywhere except where it
-- mattered, and an administrator previewing Pro exercised their real access
-- rather than the plan under test.
--
-- This migration adds the missing database half of that decision and re-points
-- the existing gates at it. It also closes three mutation routines that were
-- reachable by `authenticated` and never passed through a write gate at all.
--
-- Non-destructive and forward-only. No table, column, policy, grant, trigger or
-- row is dropped. `public.user_subscriptions` is not read for anything but the
-- tier resolution it already fed, and not written at all: no billing, trial,
-- status or stored-tier field is touched anywhere in this file.

-- The trusted access resolver: the database's answer to "what may this account
-- open right now?", matching `resolveAccountAccess` in the application exactly.
--
--   * an ordinary account gets its subscription tier and nothing else — a stored
--     preview belonging to an account that is not currently an administrator is
--     ignored, so demoting an account withdraws its simulation in the same read;
--   * an administrator with no live preview gets Elite, because the role grants
--     the product without granting a subscription;
--   * an administrator with a live preview gets exactly that preview's tier,
--     with `elite_trial` carrying Elite and `expired_trial` carrying Basic — the
--     same two shared mappings the application uses;
--   * a lapsed preview is not consulted, which is what makes a forgotten preview
--     return to real access on its own;
--   * a missing role row, a missing subscription, a null caller or an
--     unrecognised mode can only ever resolve to 'basic'. Fail closed.
--
-- Deliberately private: revoked from public, anon and authenticated, so it is
-- reachable only from the trusted routines below. A client cannot ask it for an
-- answer about another account, or about itself.
create or replace function public.resolve_effective_access_tier(
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
      when roles.role = 'admin'
        and preview.mode is not null
        and preview.expires_at > input_as_of
        then case preview.mode
          when 'basic' then 'basic'
          when 'pro' then 'pro'
          when 'elite' then 'elite'
          when 'elite_trial' then 'elite'
          when 'expired_trial' then 'basic'
          -- 'actual' is not a stored state; anything else is unrecognised. Both
          -- mean "no simulation is running", which for an administrator is Elite.
          else 'elite'
        end
      when roles.role = 'admin' then 'elite'
      else public.resolve_effective_subscription_tier(input_user_id, input_as_of)
    end
    from (select input_user_id as subject_id) as subject
    left join public.user_roles as roles on roles.user_id = subject.subject_id
    left join public.admin_access_previews as preview on preview.user_id = subject.subject_id
    where subject.subject_id is not null
  ), 'basic')
$$;

revoke all on function public.resolve_effective_access_tier(uuid,timestamptz)
  from public, anon, authenticated;

-- The single write gate for portfolio-scoped mutations, unchanged except for
-- the one line that decides the tier. Reads are still never gated here: an
-- over-limit portfolio stays fully visible.
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

  effective_tier := public.resolve_effective_access_tier(owner_id, statement_timestamp());
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

-- The create and restore limits, likewise unchanged but for the tier line. The
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
  effective_tier := public.resolve_effective_access_tier(
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

-- The Options capability itself, for writes that are not scoped to a portfolio
-- the reader chose. `assert_portfolio_writable` answers "may this portfolio be
-- written?"; this answers "may this account write Options data at all?", which
-- is the question the position routines below actually ask.
create or replace function public.assert_options_writable()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if public.resolve_effective_access_tier(requesting_user, statement_timestamp()) = 'basic' then
    raise exception 'UPGRADE_REQUIRED:portfolio.options.write' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_options_writable() from public, anon, authenticated;

-- The four option-position routines predate both the entitlement foundation and
-- the ledger that superseded them. They are still granted to `authenticated`,
-- still reachable directly over PostgREST, and passed through no write gate —
-- so a Basic account could write Options data through them while every gated
-- path refused. The bodies below are unchanged apart from the added assertion.
create or replace function public.create_option_position(
  input_underlying_symbol text, input_option_kind text, input_contracts integer, input_premium_per_share numeric,
  input_strike_price numeric, input_opened_at date, input_expiration_date date, input_implied_volatility numeric,
  input_delta numeric, input_theta numeric, input_note text, input_status text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid; result_id uuid;
begin
  perform public.assert_options_writable();
  target_portfolio := public.get_or_create_default_portfolio();
  perform 1 from public.portfolios where id = target_portfolio and user_id = (select auth.uid()) for update;
  insert into public.portfolio_option_positions (portfolio_id, underlying_symbol, option_kind, contracts, premium_per_share, strike_price, opened_at, expiration_date, implied_volatility, delta, theta, note, status, idempotency_key)
  values (target_portfolio, upper(trim(input_underlying_symbol)), input_option_kind, input_contracts, input_premium_per_share, input_strike_price, input_opened_at, input_expiration_date, input_implied_volatility, input_delta, input_theta, nullif(trim(input_note), ''), input_status, input_idempotency_key)
  on conflict (portfolio_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.update_option_position(
  position_id uuid, input_underlying_symbol text, input_option_kind text, input_contracts integer, input_premium_per_share numeric,
  input_strike_price numeric, input_opened_at date, input_expiration_date date, input_implied_volatility numeric,
  input_delta numeric, input_theta numeric, input_note text, input_status text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_options_writable();
  update public.portfolio_option_positions op set underlying_symbol = upper(trim(input_underlying_symbol)), option_kind = input_option_kind,
    contracts = input_contracts, premium_per_share = input_premium_per_share, strike_price = input_strike_price,
    opened_at = input_opened_at, expiration_date = input_expiration_date, implied_volatility = input_implied_volatility,
    delta = input_delta, theta = input_theta, note = nullif(trim(input_note), ''), status = input_status,
    closed_at = case when input_status = 'closed' then op.closed_at else null end, updated_at = now()
  from public.portfolios p where op.id = position_id and p.id = op.portfolio_id and p.user_id = (select auth.uid());
  if not found then raise exception 'Option position not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.close_option_position(position_id uuid, input_closed_at date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_options_writable();
  update public.portfolio_option_positions op set status = 'closed', closed_at = input_closed_at, updated_at = now()
  from public.portfolios p where op.id = position_id and p.id = op.portfolio_id and p.user_id = (select auth.uid()) and op.status = 'open';
  if not found then raise exception 'Open option position not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.delete_option_position(position_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_options_writable();
  delete from public.portfolio_option_positions op using public.portfolios p
  where op.id = position_id and p.id = op.portfolio_id and p.user_id = (select auth.uid());
  if not found then raise exception 'Option position not found' using errcode = '42501'; end if;
end;
$$;

-- The pre-ledger transaction routines have the same problem from the other
-- direction: they resolve the owning portfolio from a transaction id and mutate
-- it without ever asking whether that portfolio accepts writes. A Basic reader
-- could edit or delete rows in an Options portfolio, or in a stock portfolio the
-- read-only downgrade had closed, by calling them directly. Gated here with the
-- same assertion their ledger replacements already use; the bodies are otherwise
-- unchanged.
create or replace function public.create_portfolio_transaction(
  input_type text, input_symbol text, input_quantity numeric, input_price numeric,
  input_amount numeric, input_occurred_at date, input_note text, input_idempotency_key uuid,
  input_original_currency text, input_fx_rate_at_transaction numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid; result_id uuid; normalized numeric(28,8);
begin
  target_portfolio := public.get_or_create_default_portfolio();
  perform public.assert_portfolio_writable(target_portfolio);
  perform 1 from public.portfolios where id = target_portfolio and user_id = (select auth.uid()) for update;
  normalized := case
    when input_amount is null then null
    when input_original_currency = 'USD' then input_amount
    when input_original_currency = 'THB' and input_fx_rate_at_transaction > 0 then round(input_amount / input_fx_rate_at_transaction, 8)
    else null
  end;
  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, symbol, quantity, price, amount, occurred_at, note, idempotency_key,
    original_amount, original_currency, fx_rate_at_transaction, normalized_amount_usd
  ) values (
    target_portfolio, input_type, nullif(upper(trim(input_symbol)), ''), input_quantity, input_price,
    input_amount, input_occurred_at, nullif(trim(input_note), ''), input_idempotency_key,
    input_amount, coalesce(input_original_currency, 'USD'), input_fx_rate_at_transaction, normalized
  ) on conflict (portfolio_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into result_id;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
  return result_id;
end;
$$;

create or replace function public.update_portfolio_transaction(
  transaction_id uuid, input_type text, input_symbol text, input_quantity numeric, input_price numeric,
  input_amount numeric, input_occurred_at date, input_note text, input_original_currency text,
  input_fx_rate_at_transaction numeric
) returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid; normalized numeric(28,8);
begin
  select pt.portfolio_id into target_portfolio from public.portfolio_transactions pt
  join public.portfolios p on p.id = pt.portfolio_id
  where pt.id = transaction_id and p.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio);
  perform 1 from public.portfolios where id = target_portfolio for update;
  normalized := case
    when input_amount is null then null
    when input_original_currency = 'USD' then input_amount
    when input_original_currency = 'THB' and input_fx_rate_at_transaction > 0 then round(input_amount / input_fx_rate_at_transaction, 8)
    else null
  end;
  update public.portfolio_transactions set transaction_type = input_type,
    symbol = nullif(upper(trim(input_symbol)), ''), quantity = input_quantity, price = input_price,
    amount = input_amount, original_amount = input_amount, original_currency = coalesce(input_original_currency, 'USD'),
    fx_rate_at_transaction = input_fx_rate_at_transaction, normalized_amount_usd = normalized,
    occurred_at = input_occurred_at, note = nullif(trim(input_note), ''), updated_at = now()
  where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

create or replace function public.delete_portfolio_transaction(transaction_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid;
begin
  select pt.portfolio_id into target_portfolio from public.portfolio_transactions pt
  join public.portfolios p on p.id = pt.portfolio_id
  where pt.id = transaction_id and p.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  perform public.assert_portfolio_writable(target_portfolio);
  perform 1 from public.portfolios where id = target_portfolio for update;
  delete from public.portfolio_transactions where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

-- `archive_portfolio` and `restore_portfolio` deliberately keep no write gate,
-- for the reason Phase 2 gave: archiving is the escape hatch a downgraded reader
-- needs to put an extra portfolio away without losing it, and restoring is
-- already bounded by the limit trigger above — which now reads the access tier,
-- so an administrator previewing Basic is held to the Basic allowance there too.
--
-- `set_portfolio_base_currency` and `set_aggregate_portfolio_goal` likewise stay
-- ungated: both are account-level display settings that every tier has, and
-- neither reads or writes premium data.

commit;
