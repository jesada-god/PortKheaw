begin;

-- ===========================================================================
-- Moving assets between portfolios, and deleting a portfolio you can undo
-- ===========================================================================
--
-- Two gaps closed here, and they are the same gap seen from two sides.
--
-- A portfolio could only be *archived* — it stayed on the page, greyed out, and
-- the only true deletion was `delete_empty_portfolio`, which refuses anything
-- that has ever had a transaction. So a portfolio that had held one share could
-- never be removed, and there was no way to rescue what was in it first. The
-- product's answer to "I want this portfolio gone" was "you cannot".
--
-- And a transfer could only move cash. `transfer_portfolio_cash` writes a paired
-- `transfer_out`/`transfer_in` into the one ledger, which is exactly the right
-- shape — it just had no way to say "and six shares of AAPL". So the only way to
-- move a position was to sell it in one portfolio and buy it in the other, which
-- invents a realized gain that never happened and resets a cost basis that
-- should have been carried across untouched.
--
-- Everything below reuses what is already here rather than adding a parallel
-- system:
--
--   * assets move as the same paired ledger rows cash already moves as, with a
--     `transfer_group_id` tying every leg of one operation together;
--   * `assert_portfolio_ledger_valid` learns the new legs, so the existing
--     invariant checker is still the thing that refuses an impossible ledger;
--   * `assert_portfolio_writable` still gates every write, at both ends;
--   * the purge runs on the same pg_cron the trial-retention sweep runs on.
--
-- What a transfer is *not*: it is not a sale, it does not touch cash, it does
-- not realize a gain, and it does not send an order anywhere. It moves quantity
-- and the exact cost basis that quantity was carrying.

-- ---------------------------------------------------------------------------
-- 1. The ledger columns an asset leg needs
-- ---------------------------------------------------------------------------
--
-- `transfer_cost_basis_usd` rather than `amount` is the load-bearing choice.
--
-- `amount` is what every cash path in the codebase reads to move cash: the
-- portfolio engine, `cash_effect_for_transaction`, the statement view, the
-- derived-cash sum inside `delete_empty_portfolio`. Had an asset leg carried its
-- cost basis in `amount`, every one of those would have read a share transfer as
-- a cash transfer and moved money that never moved. A separate column cannot be
-- misread by code that predates it: to old readers an asset leg has `amount is
-- null`, and null cash is no cash.
--
-- It is a *total*, not a unit price, because the total is the number that has to
-- balance. The source removes exactly this much basis and the destination adds
-- exactly this much; deriving it from `quantity * price` at each end would let
-- the two ends round apart by a fraction of a cent and quietly leak cost basis.
-- `price` is still written, as the unit cost, for display and for nothing else.
alter table public.portfolio_transactions
  add column if not exists transfer_group_id uuid,
  add column if not exists transfer_cost_basis_usd numeric(28,8),
  add column if not exists transfer_acquired_at timestamptz,
  add column if not exists transfer_source_name text,
  add column if not exists transfer_destination_name text;

/*
 * The names are an immutable snapshot, written once at transfer time.
 *
 * They exist because the source portfolio can later be purged. When it is, the
 * destination's `counterparty_portfolio_id` is set to NULL — the row itself is
 * never touched, because it is part of a *surviving* portfolio's ledger and
 * deleting it would silently change that portfolio's holdings and its cost
 * basis. Without a snapshot the destination would be left holding shares whose
 * origin reads as a dangling id; with one it still reads "received from a
 * deleted portfolio", by name.
 *
 * Deliberately not a foreign key and deliberately never updated: renaming a
 * portfolio afterwards must not rewrite what a past transfer said.
 */

-- Existing cash transfers pre-date grouping. Each was its own single-leg
-- operation, so its own `transfer_id` is the honest group id. Re-runnable: the
-- second pass matches nothing.
update public.portfolio_transactions
set transfer_group_id = transfer_id
where transaction_type in ('transfer_out', 'transfer_in')
  and transfer_id is not null
  and transfer_group_id is null;

create index if not exists portfolio_transactions_transfer_group_idx
  on public.portfolio_transactions (transfer_group_id)
  where transfer_group_id is not null;

alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_transfer_metadata,
  drop constraint if exists portfolio_transactions_fields;

alter table public.portfolio_transactions
  add constraint portfolio_transactions_transfer_metadata check (
    (
      transaction_type in ('transfer_out', 'transfer_in')
      and transfer_id is not null
      and transfer_group_id is not null
      -- Nullable, unlike before: a purged source portfolio leaves the surviving
      -- side pointing at nothing, and that row must remain legal.
      and (counterparty_portfolio_id is null or counterparty_portfolio_id <> portfolio_id)
    )
    or (
      transaction_type not in ('transfer_out', 'transfer_in')
      and transfer_id is null
      and transfer_group_id is null
      and counterparty_portfolio_id is null
      and transfer_cost_basis_usd is null
      and transfer_acquired_at is null
      and transfer_source_name is null
      and transfer_destination_name is null
    )
  ),
  add constraint portfolio_transactions_fields check (
    (
      transaction_type in ('acquisition', 'disposal')
      and symbol is not null and quantity > 0 and price > 0 and amount is null and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
      and transfer_cost_basis_usd is null
    )
    or (
      transaction_type = 'initial_position'
      and symbol is not null and quantity > 0 and price > 0 and amount >= 0 and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
      and transfer_cost_basis_usd is null
    )
    or (
      transaction_type in ('dividend', 'deposit', 'withdrawal', 'fee')
      and symbol is null and quantity is null and price is null and amount > 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
      and transfer_cost_basis_usd is null
    )
    or (
      transaction_type = 'adjustment'
      and symbol is null and quantity is null and price is null and amount <> 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
      and transfer_cost_basis_usd is null
    )
    -- A cash transfer leg: unchanged from the multi-portfolio release, and the
    -- shape every existing transfer row already has.
    or (
      transaction_type in ('transfer_out', 'transfer_in')
      and symbol is null and quantity is null and price is null and amount > 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
      and transfer_cost_basis_usd is null
    )
    -- An equity transfer leg. `amount` is null, so no cash reader sees cash;
    -- `transfer_cost_basis_usd` is the basis moving with the shares. `price` is
    -- allowed to be zero because a fully written-down basis is representable,
    -- and refusing it would be a rule about arithmetic rather than about money.
    or (
      transaction_type in ('transfer_out', 'transfer_in')
      and symbol is not null and quantity > 0 and price >= 0 and amount is null and fee is null
      and transfer_cost_basis_usd is not null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    -- An option transfer leg, carrying the whole contract identity so the
    -- destination position is the same contract and not a lookalike.
    or (
      transaction_type in ('transfer_out', 'transfer_in')
      and symbol is null and quantity > 0 and price >= 0 and amount is null and fee is null
      and transfer_cost_basis_usd is not null
      and underlying_symbol is not null and contract_symbol is not null
      and option_kind in ('call', 'put') and option_side in ('long', 'short')
      and strike_price > 0 and expiration_date is not null and multiplier > 0
    )
    or (
      transaction_type in ('buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired')
      and symbol is null and quantity > 0 and price >= 0 and amount is null and fee >= 0
      and underlying_symbol is not null and contract_symbol is not null
      and option_kind in ('call', 'put') and option_side in ('long', 'short')
      and strike_price > 0 and expiration_date is not null and multiplier > 0
      and transfer_cost_basis_usd is null
      and (transaction_type in ('exercise', 'assignment', 'expired') or price > 0)
      and (transaction_type not in ('buy_to_open', 'sell_to_close', 'exercise') or option_side = 'long')
      and (transaction_type not in ('sell_to_open', 'buy_to_close', 'assignment') or option_side = 'short')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The invariant checker learns the new legs
-- ---------------------------------------------------------------------------
--
-- This is the routine every ledger write already ends with, and extending it —
-- rather than validating transfers somewhere new — is what keeps "the ledger
-- cannot describe an impossible position" a single rule with a single
-- implementation. A transfer that would take out more than is held is refused
-- here, by the same replay that refuses an oversized disposal.
create or replace function public.assert_portfolio_ledger_valid(target_portfolio uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  row_record record;
  equity_balances jsonb := '{}'::jsonb;
  option_balances jsonb := '{}'::jsonb;
  available numeric(28,8);
  option_available numeric(28,8);
  option_delta numeric(28,8);
  settlement_quantity numeric(28,8);
  transfer_direction numeric;
begin
  for row_record in
    select * from public.portfolio_transactions
    where portfolio_id = target_portfolio
    order by occurred_at_time asc, created_at asc, id asc
  loop
    if row_record.transaction_type in ('acquisition', 'initial_position') then
      available := coalesce((equity_balances ->> row_record.symbol)::numeric, 0);
      equity_balances := jsonb_set(equity_balances, array[row_record.symbol], to_jsonb(available + row_record.quantity));
    elsif row_record.transaction_type = 'disposal' then
      available := coalesce((equity_balances ->> row_record.symbol)::numeric, 0);
      if row_record.quantity > available then
        raise exception 'Disposal exceeds available quantity for %', row_record.symbol using errcode = '23514';
      end if;
      equity_balances := jsonb_set(equity_balances, array[row_record.symbol], to_jsonb(available - row_record.quantity));
    elsif row_record.transaction_type in ('transfer_out', 'transfer_in') and row_record.symbol is not null then
      available := coalesce((equity_balances ->> row_record.symbol)::numeric, 0);
      if row_record.transaction_type = 'transfer_out' then
        if row_record.quantity > available then
          raise exception 'Transfer exceeds available quantity for %', row_record.symbol using errcode = '23514';
        end if;
        equity_balances := jsonb_set(equity_balances, array[row_record.symbol], to_jsonb(available - row_record.quantity));
      else
        equity_balances := jsonb_set(equity_balances, array[row_record.symbol], to_jsonb(available + row_record.quantity));
      end if;
    end if;

    if row_record.transaction_type in ('exercise', 'assignment') then
      settlement_quantity := row_record.quantity * row_record.multiplier;
      available := coalesce((equity_balances ->> row_record.underlying_symbol)::numeric, 0);
      if (
        (row_record.transaction_type = 'exercise' and row_record.option_kind = 'call')
        or (row_record.transaction_type = 'assignment' and row_record.option_kind = 'put')
      ) then
        equity_balances := jsonb_set(equity_balances, array[row_record.underlying_symbol], to_jsonb(available + settlement_quantity));
      else
        if settlement_quantity > available then
          raise exception 'Option settlement exceeds available quantity for %', row_record.underlying_symbol using errcode = '23514';
        end if;
        equity_balances := jsonb_set(equity_balances, array[row_record.underlying_symbol], to_jsonb(available - settlement_quantity));
      end if;
    end if;

    if row_record.contract_symbol is not null then
      option_available := coalesce((option_balances ->> row_record.contract_symbol)::numeric, 0);
      /*
       * A signed contract balance: long lots are positive, short lots negative.
       * A transfer therefore moves the balance *towards zero* on the way out and
       * *away from zero* on the way in, whichever side the position is on — one
       * expression instead of four branches, and it cannot flip a long into a
       * short by accident.
       */
      transfer_direction := case when row_record.option_side = 'long' then 1 else -1 end;
      option_delta := case
        when row_record.transaction_type = 'buy_to_open' then row_record.quantity
        when row_record.transaction_type = 'sell_to_open' then -row_record.quantity
        when row_record.transaction_type in ('sell_to_close', 'exercise') then -row_record.quantity
        when row_record.transaction_type in ('buy_to_close', 'assignment') then row_record.quantity
        when row_record.transaction_type = 'expired' and row_record.option_side = 'long' then -row_record.quantity
        when row_record.transaction_type = 'expired' and row_record.option_side = 'short' then row_record.quantity
        when row_record.transaction_type = 'transfer_in' then transfer_direction * row_record.quantity
        when row_record.transaction_type = 'transfer_out' then -transfer_direction * row_record.quantity
        else 0
      end;
      if row_record.transaction_type = 'buy_to_open' and option_available < 0 then
        raise exception 'Cannot open a long lot while a short lot remains for %', row_record.contract_symbol using errcode = '23514';
      end if;
      if row_record.transaction_type = 'sell_to_open' and option_available > 0 then
        raise exception 'Cannot open a short lot while a long lot remains for %', row_record.contract_symbol using errcode = '23514';
      end if;
      -- The same mixing rule for an incoming transfer: a portfolio holding a
      -- short lot must not receive a long lot of the identical contract, or the
      -- two would silently net against each other.
      if row_record.transaction_type = 'transfer_in'
         and option_available <> 0
         and sign(option_available) <> transfer_direction then
        raise exception 'Cannot receive a % lot while the opposite lot remains for %',
          row_record.option_side, row_record.contract_symbol using errcode = '23514';
      end if;
      if row_record.transaction_type in ('sell_to_close', 'exercise')
         or (row_record.transaction_type = 'expired' and row_record.option_side = 'long')
         or (row_record.transaction_type = 'transfer_out' and row_record.option_side = 'long') then
        if row_record.quantity > option_available then
          raise exception 'Option close exceeds available long contracts for %', row_record.contract_symbol using errcode = '23514';
        end if;
      end if;
      if row_record.transaction_type in ('buy_to_close', 'assignment')
         or (row_record.transaction_type = 'expired' and row_record.option_side = 'short')
         or (row_record.transaction_type = 'transfer_out' and row_record.option_side = 'short') then
        if row_record.quantity > -option_available then
          raise exception 'Option close exceeds available short contracts for %', row_record.contract_symbol using errcode = '23514';
        end if;
      end if;
      option_balances := jsonb_set(option_balances, array[row_record.contract_symbol], to_jsonb(option_available + option_delta));
    end if;
  end loop;
end;
$$;

revoke all on function public.assert_portfolio_ledger_valid(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. What is actually open, answered by the database
-- ---------------------------------------------------------------------------
--
-- The client asks to move a quantity; the server decides whether that quantity
-- exists. These two functions are how the *transfer* re-derives that inside the
-- transaction, under lock, from the ledger — never from anything the browser
-- sent and never from a number computed a page-load ago.
--
-- They are deliberately a re-derivation and not a cache: there is no stored
-- "open quantity" anywhere in this schema, and adding one would create a second
-- truth that could drift from the ledger.
create or replace function public.portfolio_open_equity_quantity(
  input_portfolio_id uuid, input_symbol text
)
returns numeric
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(sum(
    case
      when entry.transaction_type in ('acquisition', 'initial_position') and entry.symbol = input_symbol
        then entry.quantity
      when entry.transaction_type = 'disposal' and entry.symbol = input_symbol
        then -entry.quantity
      when entry.transaction_type = 'transfer_in' and entry.symbol = input_symbol
        then entry.quantity
      when entry.transaction_type = 'transfer_out' and entry.symbol = input_symbol
        then -entry.quantity
      -- Settlement moves the *underlying*, which is why an option row can change
      -- an equity balance and why this cannot be a plain filter on `symbol`.
      when entry.transaction_type = 'exercise' and entry.underlying_symbol = input_symbol and entry.option_kind = 'call'
        then entry.quantity * entry.multiplier
      when entry.transaction_type = 'exercise' and entry.underlying_symbol = input_symbol and entry.option_kind = 'put'
        then -entry.quantity * entry.multiplier
      when entry.transaction_type = 'assignment' and entry.underlying_symbol = input_symbol and entry.option_kind = 'put'
        then entry.quantity * entry.multiplier
      when entry.transaction_type = 'assignment' and entry.underlying_symbol = input_symbol and entry.option_kind = 'call'
        then -entry.quantity * entry.multiplier
      else 0
    end
  ), 0)
  from public.portfolio_transactions as entry
  where entry.portfolio_id = input_portfolio_id
$$;

-- Signed, matching `assert_portfolio_ledger_valid`: positive is a long balance,
-- negative a short one. Zero means closed, and closed is not transferable.
create or replace function public.portfolio_open_option_contracts(
  input_portfolio_id uuid, input_contract_symbol text
)
returns numeric
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(sum(
    case
      when entry.transaction_type = 'buy_to_open' then entry.quantity
      when entry.transaction_type = 'sell_to_open' then -entry.quantity
      when entry.transaction_type in ('sell_to_close', 'exercise') then -entry.quantity
      when entry.transaction_type in ('buy_to_close', 'assignment') then entry.quantity
      when entry.transaction_type = 'expired' and entry.option_side = 'long' then -entry.quantity
      when entry.transaction_type = 'expired' and entry.option_side = 'short' then entry.quantity
      when entry.transaction_type = 'transfer_in'
        then case when entry.option_side = 'long' then entry.quantity else -entry.quantity end
      when entry.transaction_type = 'transfer_out'
        then case when entry.option_side = 'long' then -entry.quantity else entry.quantity end
      else 0
    end
  ), 0)
  from public.portfolio_transactions as entry
  where entry.portfolio_id = input_portfolio_id
    and entry.contract_symbol = input_contract_symbol
$$;

revoke all on function public.portfolio_open_equity_quantity(uuid, text) from public, anon, authenticated;
revoke all on function public.portfolio_open_option_contracts(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The transfer itself
-- ---------------------------------------------------------------------------
--
-- One statement, one transaction, all legs or none.
--
-- The division of labour is deliberate. The *server action* loads the ledger and
-- runs the canonical portfolio engine to work out what each leg carries — the
-- exact cost basis, the exact average premium — because that engine is the one
-- definition of cost basis this product has and reimplementing it in plpgsql
-- would create a second one. This routine then refuses to trust the result: it
-- re-derives every open quantity from the ledger under lock and compares it with
-- what the preview claimed to have seen. Amounts come from the server; the
-- *right to move them* is granted here.
--
-- `input_expected` is that comparison — the position fingerprint. It contains
-- only ledger-derived quantities, never a price and never a market value, so it
-- can only be invalidated by the user's own writes. A fingerprint over anything
-- that moves on its own would refuse honest transfers all day.
create or replace function public.transfer_portfolio_assets(
  input_source_portfolio_id uuid,
  input_destination_portfolio_id uuid,
  input_group_id uuid,
  input_legs jsonb,
  input_expected jsonb,
  input_occurred_at timestamptz,
  input_note text
)
returns table (transfer_group_id uuid, legs_written integer, already_applied boolean)
language plpgsql
security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  requesting_user uuid := (select auth.uid());
  source_portfolio public.portfolios%rowtype;
  destination_portfolio public.portfolios%rowtype;
  leg jsonb;
  expectation jsonb;
  observed numeric(28,8);
  claimed numeric(28,8);
  written integer := 0;
  leg_kind text;
  leg_quantity numeric(28,8);
  leg_cost numeric(28,8);
  occurred timestamptz := coalesce(input_occurred_at, now());
  clean_note text := nullif(btrim(input_note), '');
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_group_id is null then
    raise exception 'TRANSFER_GROUP_REQUIRED' using errcode = '22023';
  end if;
  if input_source_portfolio_id = input_destination_portfolio_id then
    raise exception 'Transfer portfolios must differ' using errcode = '22023';
  end if;
  if input_legs is null or jsonb_typeof(input_legs) <> 'array' or jsonb_array_length(input_legs) = 0 then
    raise exception 'TRANSFER_NOTHING_TO_MOVE' using errcode = '22023';
  end if;

  /*
   * The idempotency key, and the reason a double submit is harmless: the group
   * id is minted once when the preview is built. A second call carrying the same
   * id finds the first call's rows and returns without writing. Checked before
   * the locks, so a retry does not queue behind the run it is a duplicate of.
   */
  if exists (
    select 1 from public.portfolio_transactions as existing
    where existing.transfer_group_id = input_group_id
  ) then
    return query select input_group_id, 0, true;
    return;
  end if;

  -- Locked in id order, which is the same order `transfer_portfolio_cash` takes
  -- them in. Two transfers between the same pair therefore queue rather than
  -- deadlock.
  select portfolio.* into source_portfolio
  from public.portfolios as portfolio
  where portfolio.id = input_source_portfolio_id
    and portfolio.user_id = requesting_user
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;

  select portfolio.* into destination_portfolio
  from public.portfolios as portfolio
  where portfolio.id = input_destination_portfolio_id
    and portfolio.user_id = requesting_user
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;

  -- Ownership is settled above by the `user_id` predicate: a portfolio belonging
  -- to somebody else is simply not found, and there is no code path that reaches
  -- a row this session does not own.
  if source_portfolio.deleted_at is not null or destination_portfolio.deleted_at is not null then
    raise exception 'TRANSFER_PORTFOLIO_DELETED' using errcode = '42501';
  end if;
  if destination_portfolio.archived_at is not null then
    raise exception 'Archived portfolio cannot receive new transactions' using errcode = '23514';
  end if;

  perform public.assert_portfolio_writable(input_source_portfolio_id);
  perform public.assert_portfolio_writable(input_destination_portfolio_id);

  /*
   * Staleness, checked before anything is written.
   *
   * Every position the plan touches is re-counted from the ledger and compared
   * with what the preview saw. A share sold, a contract expired, a quantity that
   * grew — any of them lands here as one typed error, and the caller reloads the
   * preview rather than being handed a partial move.
   */
  for expectation in select * from jsonb_array_elements(coalesce(input_expected, '[]'::jsonb)) loop
    if expectation ->> 'kind' = 'equity' then
      observed := public.portfolio_open_equity_quantity(input_source_portfolio_id, expectation ->> 'key');
    elsif expectation ->> 'kind' = 'option' then
      observed := public.portfolio_open_option_contracts(input_source_portfolio_id, expectation ->> 'key');
    else
      continue;
    end if;
    claimed := (expectation ->> 'quantity')::numeric;
    if observed is distinct from claimed then
      raise exception 'TRANSFER_POSITIONS_CHANGED' using errcode = 'P0001';
    end if;
  end loop;

  for leg in select * from jsonb_array_elements(input_legs) loop
    leg_kind := leg ->> 'kind';
    leg_quantity := (leg ->> 'quantity')::numeric;
    leg_cost := (leg ->> 'costBasisUsd')::numeric;

    -- A closed position has nothing to move, and a zero-quantity leg is what a
    -- closed one would look like if it ever reached here. Refused rather than
    -- skipped, because a plan containing one is a plan that was built wrong.
    if leg_kind <> 'cash' and (leg_quantity is null or leg_quantity <= 0) then
      raise exception 'TRANSFER_EMPTY_LEG' using errcode = '22023';
    end if;

    if leg_kind = 'cash' then
      if leg_cost is null or leg_cost <= 0 then
        raise exception 'Transfer amount must be greater than zero' using errcode = '22023';
      end if;
      insert into public.portfolio_transactions (
        portfolio_id, transaction_type, amount, original_amount, original_currency,
        normalized_amount_usd, occurred_at, occurred_at_time, note, idempotency_key,
        transfer_id, transfer_group_id, counterparty_portfolio_id,
        transfer_source_name, transfer_destination_name
      )
      select
        side.portfolio_id, side.transaction_type, leg_cost, leg_cost, 'USD', leg_cost,
        (occurred at time zone 'Asia/Bangkok')::date, occurred, clean_note,
        (leg ->> 'transferId')::uuid, (leg ->> 'transferId')::uuid, input_group_id,
        side.counterparty, source_portfolio.name, destination_portfolio.name
      from (
        values
          (input_source_portfolio_id, 'transfer_out', input_destination_portfolio_id),
          (input_destination_portfolio_id, 'transfer_in', input_source_portfolio_id)
      ) as side(portfolio_id, transaction_type, counterparty);
      written := written + 2;

    elsif leg_kind = 'equity' then
      if leg_cost is null then
        raise exception 'TRANSFER_COST_BASIS_REQUIRED' using errcode = '22023';
      end if;
      insert into public.portfolio_transactions (
        portfolio_id, transaction_type, symbol, quantity, price, normalized_price_usd,
        original_currency, occurred_at, occurred_at_time, note, idempotency_key,
        transfer_id, transfer_group_id, counterparty_portfolio_id,
        transfer_cost_basis_usd, transfer_acquired_at,
        transfer_source_name, transfer_destination_name
      )
      select
        side.portfolio_id, side.transaction_type, upper(btrim(leg ->> 'symbol')),
        leg_quantity, (leg ->> 'unitCostUsd')::numeric, (leg ->> 'unitCostUsd')::numeric,
        'USD', (occurred at time zone 'Asia/Bangkok')::date, occurred, clean_note,
        (leg ->> 'transferId')::uuid, (leg ->> 'transferId')::uuid, input_group_id,
        side.counterparty, leg_cost, (leg ->> 'acquiredAt')::timestamptz,
        source_portfolio.name, destination_portfolio.name
      from (
        values
          (input_source_portfolio_id, 'transfer_out', input_destination_portfolio_id),
          (input_destination_portfolio_id, 'transfer_in', input_source_portfolio_id)
      ) as side(portfolio_id, transaction_type, counterparty);
      written := written + 2;

    elsif leg_kind = 'option' then
      if leg_cost is null then
        raise exception 'TRANSFER_COST_BASIS_REQUIRED' using errcode = '22023';
      end if;
      /*
       * An expired contract is not an asset. The plan builder already excludes
       * one, and this refuses it a second time, from the row's own expiry rather
       * than from a status somebody computed earlier. Compared in UTC because
       * that is the calendar the option engine measures days-to-expiry against;
       * comparing in Bangkok time would refuse a contract for several hours on
       * its last legal day.
       */
      if (leg ->> 'expirationDate')::date < (now() at time zone 'UTC')::date then
        raise exception 'TRANSFER_OPTION_EXPIRED' using errcode = '23514';
      end if;
      insert into public.portfolio_transactions (
        portfolio_id, transaction_type, quantity, price, normalized_price_usd,
        original_currency, occurred_at, occurred_at_time, note, idempotency_key,
        transfer_id, transfer_group_id, counterparty_portfolio_id,
        underlying_symbol, contract_symbol, option_kind, option_side,
        strike_price, expiration_date, multiplier,
        transfer_cost_basis_usd, transfer_acquired_at,
        transfer_source_name, transfer_destination_name
      )
      select
        side.portfolio_id, side.transaction_type, leg_quantity,
        (leg ->> 'unitCostUsd')::numeric, (leg ->> 'unitCostUsd')::numeric,
        'USD', (occurred at time zone 'Asia/Bangkok')::date, occurred, clean_note,
        (leg ->> 'transferId')::uuid, (leg ->> 'transferId')::uuid, input_group_id,
        side.counterparty,
        upper(btrim(leg ->> 'underlyingSymbol')), upper(btrim(leg ->> 'contractSymbol')),
        leg ->> 'optionKind', leg ->> 'optionSide',
        (leg ->> 'strikePrice')::numeric, (leg ->> 'expirationDate')::date,
        (leg ->> 'multiplier')::numeric,
        leg_cost, (leg ->> 'acquiredAt')::timestamptz,
        source_portfolio.name, destination_portfolio.name
      from (
        values
          (input_source_portfolio_id, 'transfer_out', input_destination_portfolio_id),
          (input_destination_portfolio_id, 'transfer_in', input_source_portfolio_id)
      ) as side(portfolio_id, transaction_type, counterparty);
      written := written + 2;

    else
      raise exception 'TRANSFER_LEG_UNKNOWN' using errcode = '22023';
    end if;
  end loop;

  -- Both ends replayed. A plan that would leave either portfolio describing an
  -- impossible position fails here, and the whole statement rolls back — which
  -- is the guarantee that an asset is never in flight between two ledgers.
  perform public.assert_portfolio_ledger_valid(input_source_portfolio_id);
  perform public.assert_portfolio_ledger_valid(input_destination_portfolio_id);

  return query select input_group_id, written, false;
end;
$$;

revoke all on function public.transfer_portfolio_assets(uuid, uuid, uuid, jsonb, jsonb, timestamptz, text)
  from public, anon;
grant execute on function public.transfer_portfolio_assets(uuid, uuid, uuid, jsonb, jsonb, timestamptz, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Deleting a portfolio, reversibly
-- ---------------------------------------------------------------------------
--
-- `deleted_at` is a *third* state, deliberately separate from `archived_at`.
-- Archiving keeps a portfolio on the page, still counted in the aggregate,
-- refusing new rows. Deleting takes it off every surface at once. Reusing one
-- column for both would have made "archived" and "deleted" indistinguishable to
-- every existing query, and there are a lot of existing queries.
--
-- `purge_after` is stamped once, at deletion, and never recomputed — the same
-- reason the trial ledger stamps its own deadline: a window that is recomputed
-- from today's policy lets a future edit reach back and shorten a promise
-- already made.
alter table public.portfolios
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_after timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portfolios_deleted_state_check'
  ) then
    alter table public.portfolios
      add constraint portfolios_deleted_state_check
      check ((deleted_at is null) = (purge_after is null));
  end if;
end;
$$;

create index if not exists portfolios_purge_due_idx
  on public.portfolios (purge_after)
  where deleted_at is not null;

/*
 * The name uniqueness index becomes partial.
 *
 * It was not, which would have meant that deleting "หุ้นระยะยาว" left its name
 * reserved for seven days: the very next thing a person does after deleting a
 * portfolio is often recreating it, and they would have been told the name was
 * taken by something they could no longer see. A deleted portfolio holds no
 * name. Restoring one that has since been recreated is handled where it belongs,
 * in `restore_deleted_portfolio`, by renaming the row coming back.
 */
drop index if exists public.portfolios_owner_type_normalized_name_key;
create unique index if not exists portfolios_owner_type_normalized_name_key
  on public.portfolios (user_id, portfolio_type, lower(btrim(name)))
  where deleted_at is null;

drop index if exists public.portfolios_owner_active_type_idx;
create index if not exists portfolios_owner_active_type_idx
  on public.portfolios (user_id, portfolio_type, created_at)
  where archived_at is null and deleted_at is null;

-- A deleted portfolio must not hold a slot against the plan limit; the whole
-- point of deleting one is to make room.
create or replace function public.enforce_portfolio_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare active_count integer;
begin
  if new.portfolio_type not in ('STOCK', 'OPTION')
    or new.archived_at is not null
    or new.deleted_at is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.portfolio_type, 0));
  select count(*) into active_count
  from public.portfolios as portfolio
  where portfolio.user_id = new.user_id
    and portfolio.portfolio_type = new.portfolio_type
    and portfolio.archived_at is null
    and portfolio.deleted_at is null
    and portfolio.id <> new.id;
  if active_count >= 10 then
    raise exception 'Portfolio limit reached for %', new.portfolio_type using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists portfolios_enforce_limit on public.portfolios;
create trigger portfolios_enforce_limit
before insert or update of portfolio_type, archived_at, deleted_at on public.portfolios
for each row execute function public.enforce_portfolio_limit();

revoke all on function public.enforce_portfolio_limit() from public, anon, authenticated;

-- The Basic tier's one writable stock portfolio must never resolve to a deleted
-- one, or deleting it would leave the account with no writable portfolio at all
-- while a perfectly good one sat next to it.
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
    and portfolio.deleted_at is null
  order by portfolio.created_at, portfolio.id
  limit 1
$$;

revoke all on function public.basic_writable_stock_portfolio(uuid) from public, anon, authenticated;

-- Every ledger write already funnels through here, so this one line closes the
-- whole write surface against a deleted portfolio: no transaction, no option
-- target, no transfer, no reconciliation.
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
  if owned_portfolio.deleted_at is not null then
    raise exception 'Portfolio not found' using errcode = '42501';
  end if;
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

-- Cash transfers get the same treatment: a deleted portfolio is neither a source
-- nor a destination.
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
    and user_id = requesting_user and archived_at is null and deleted_at is null
  order by id for update;
  if (select count(*) from public.portfolios
      where id in (source_portfolio_id, destination_portfolio_id)
        and user_id = requesting_user and archived_at is null and deleted_at is null) <> 2 then
    raise exception 'Transfer portfolios not found or archived' using errcode = '42501';
  end if;
  perform public.assert_portfolio_writable(source_portfolio_id);
  perform public.assert_portfolio_writable(destination_portfolio_id);
  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, amount, original_amount, original_currency,
    normalized_amount_usd, occurred_at, occurred_at_time, note, idempotency_key,
    transfer_id, transfer_group_id, counterparty_portfolio_id
  ) values (
    source_portfolio_id, 'transfer_out', input_amount_usd, input_amount_usd, 'USD',
    input_amount_usd, (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at, nullif(btrim(input_note), ''), input_idempotency_key,
    transfer_key, transfer_key, destination_portfolio_id
  ) on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;
  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, amount, original_amount, original_currency,
    normalized_amount_usd, occurred_at, occurred_at_time, note, idempotency_key,
    transfer_id, transfer_group_id, counterparty_portfolio_id
  ) values (
    destination_portfolio_id, 'transfer_in', input_amount_usd, input_amount_usd, 'USD',
    input_amount_usd, (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at, nullif(btrim(input_note), ''), input_idempotency_key,
    transfer_key, transfer_key, source_portfolio_id
  ) on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;
  return transfer_key;
end;
$$;

-- Archive, restore and goal-setting all stop at the deleted state, so nothing
-- reaches a portfolio the interface no longer shows.
create or replace function public.archive_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.portfolios
  set archived_at = coalesce(archived_at, now()), updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.restore_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.portfolios
  set archived_at = null, updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.get_or_create_default_portfolio()
returns uuid language plpgsql security definer set search_path = '' as $$
declare requesting_user uuid := (select auth.uid()); result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':LEGACY', 0));
  select portfolio.id into result_id
  from public.portfolios as portfolio
  where portfolio.user_id = requesting_user and portfolio.is_legacy and portfolio.deleted_at is null
  order by portfolio.created_at, portfolio.id
  limit 1;
  if result_id is null then
    insert into public.portfolios (user_id, name, portfolio_type, is_legacy, base_currency)
    select requesting_user, 'Default / Legacy', 'LEGACY', true, coalesce(settings.base_currency, 'USD')
    from (select 1) as seed
    left join public.user_settings as settings on settings.user_id = requesting_user
    returning id into result_id;
  end if;
  return result_id;
end;
$$;

-- Soft-delete, with the two refusals that matter.
--
-- The typed name is not decoration: this is the one action in the product that
-- removes a ledger from view, and a mistyped name is the difference between
-- deleting the portfolio you meant and the one next to it. Compared after
-- trimming and case-folding, because the requirement is that the person knows
-- which portfolio they are on, not that they can match whitespace.
create or replace function public.soft_delete_portfolio(
  target_portfolio_id uuid,
  input_expected_name text
)
returns timestamptz
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  owned_portfolio public.portfolios%rowtype;
  remaining_active integer;
  purge_at timestamptz;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = requesting_user
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
  if owned_portfolio.deleted_at is not null then
    raise exception 'PORTFOLIO_ALREADY_DELETED' using errcode = 'P0001';
  end if;
  if owned_portfolio.is_legacy then
    raise exception 'Legacy portfolio cannot be deleted' using errcode = '23514';
  end if;
  if lower(btrim(coalesce(input_expected_name, ''))) <> lower(btrim(owned_portfolio.name)) then
    raise exception 'PORTFOLIO_NAME_MISMATCH' using errcode = '22023';
  end if;

  perform public.assert_portfolio_writable(target_portfolio_id);

  -- Never the last one standing. An account with no portfolio it can write to
  -- has nowhere to record anything, and the interface would be asking the
  -- person to fix a state it created.
  select count(*) into remaining_active
  from public.portfolios as portfolio
  where portfolio.user_id = requesting_user
    and portfolio.deleted_at is null
    and portfolio.archived_at is null
    and portfolio.id <> target_portfolio_id;
  if remaining_active = 0 then
    raise exception 'PORTFOLIO_LAST_ACTIVE' using errcode = '23514';
  end if;

  purge_at := now() + interval '7 days';
  update public.portfolios
  set deleted_at = now(), purge_after = purge_at, updated_at = now()
  where id = target_portfolio_id;
  return purge_at;
end;
$$;

-- Restore, and the collision it has to survive.
--
-- Seven days is long enough for the name to have been reused. The row coming
-- back cannot take a name a live portfolio is holding, and refusing the restore
-- over a name would be the wrong trade — the data matters more than the label —
-- so it comes back renamed, and the returned name is what the interface reports.
create or replace function public.restore_deleted_portfolio(target_portfolio_id uuid)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  owned_portfolio public.portfolios%rowtype;
  candidate text;
  suffix integer := 2;
  name_limit integer;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = requesting_user
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
  -- Idempotent in the direction that matters: a second restore is a no-op that
  -- reports the name, not an error a double-clicking reader has to read.
  if owned_portfolio.deleted_at is null then
    return owned_portfolio.name;
  end if;
  if owned_portfolio.purge_after is not null and owned_portfolio.purge_after <= now() then
    raise exception 'PORTFOLIO_RESTORE_WINDOW_CLOSED' using errcode = 'P0001';
  end if;

  name_limit := case when owned_portfolio.is_legacy then 80 else 40 end;
  candidate := owned_portfolio.name;
  while exists (
    select 1 from public.portfolios as other
    where other.user_id = requesting_user
      and other.portfolio_type = owned_portfolio.portfolio_type
      and other.deleted_at is null
      and other.id <> owned_portfolio.id
      and lower(btrim(other.name)) = lower(btrim(candidate))
  ) loop
    -- Truncated from the left so the suffix always fits inside the column's own
    -- length rule; a restore must not fail a CHECK it cannot explain.
    candidate := left(btrim(owned_portfolio.name), greatest(1, name_limit - length(' (' || suffix || ')')))
      || ' (' || suffix || ')';
    suffix := suffix + 1;
    if suffix > 50 then
      raise exception 'PORTFOLIO_RESTORE_NAME_UNAVAILABLE' using errcode = 'P0001';
    end if;
  end loop;

  update public.portfolios
  set deleted_at = null, purge_after = null, name = candidate, updated_at = now()
  where id = target_portfolio_id;
  return candidate;
end;
$$;

revoke all on function public.soft_delete_portfolio(uuid, text) from public, anon;
revoke all on function public.restore_deleted_portfolio(uuid) from public, anon;
grant execute on function public.soft_delete_portfolio(uuid, text) to authenticated;
grant execute on function public.restore_deleted_portfolio(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The purge
-- ---------------------------------------------------------------------------
--
-- One row per run, the same shape the trial-retention sweep records, and for the
-- same reason: a job whose first real run is also the first time anybody sees it
-- work is a job nobody has ever seen work.
create table if not exists public.portfolio_purge_runs (
  run_id uuid primary key,
  mode text not null,
  scanned integer not null default 0,
  purged integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint portfolio_purge_runs_mode_check check (mode in ('dry_run', 'apply')),
  constraint portfolio_purge_runs_error_check
    check (error is null or error in ('batch_failed', 'lock_timeout'))
);

alter table public.portfolio_purge_runs enable row level security;
revoke all on table public.portfolio_purge_runs from public, anon, authenticated;

create index if not exists portfolio_purge_runs_started_idx
  on public.portfolio_purge_runs (started_at desc);

/*
 * Order is the whole of the correctness here, because every child foreign key is
 * `on delete restrict` — deliberately, so nothing can cascade a ledger away by
 * accident. The purge therefore has to dismantle its own portfolio explicitly:
 *
 *   1. release the *surviving* side of every transfer that pointed at it, by
 *      nulling `counterparty_portfolio_id`. Those rows belong to a portfolio
 *      that still exists; they are not touched otherwise, and their amounts,
 *      quantities and cost bases are unchanged — so the destination's holdings
 *      and totals are exactly what they were a moment before.
 *   2. delete the doomed portfolio's own children;
 *   3. delete the portfolio row.
 *
 * Deleting the counterparty rows instead would have been the bug: it would have
 * removed a live portfolio's incoming transfer and, with it, the shares that
 * transfer brought in.
 */
create or replace function public.purge_deleted_portfolios(
  input_run_id uuid,
  input_apply boolean default false,
  input_batch_limit integer default 100
)
returns table (run_id uuid, mode text, scanned integer, purged integer, already_recorded boolean)
language plpgsql
security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  effective_run_id uuid := coalesce(input_run_id, gen_random_uuid());
  effective_mode text := case when coalesce(input_apply, false) then 'apply' else 'dry_run' end;
  effective_limit integer := least(greatest(coalesce(input_batch_limit, 100), 1), 1000);
  due_count integer := 0;
  removed integer := 0;
  inserted_run uuid;
  existing public.portfolio_purge_runs%rowtype;
  doomed uuid[];
begin
  insert into public.portfolio_purge_runs as target (run_id, mode)
  values (effective_run_id, effective_mode)
  on conflict (run_id) do nothing
  returning target.run_id into inserted_run;

  if inserted_run is null then
    select * into existing from public.portfolio_purge_runs as prior
      where prior.run_id = effective_run_id;
    return query select existing.run_id, existing.mode, existing.scanned, existing.purged, true;
    return;
  end if;

  select count(*)::integer into due_count
  from public.portfolios as portfolio
  where portfolio.deleted_at is not null
    and portfolio.purge_after is not null
    and portfolio.purge_after <= now();

  if effective_mode = 'apply' then
    -- The retention deadline is re-read here, from the row, inside the same
    -- transaction that deletes it. A caller cannot ask for an early purge:
    -- there is no parameter for it, and the predicate is the only thing that
    -- selects a row.
    select coalesce(array_agg(candidate.id), array[]::uuid[]) into doomed
    from (
      select portfolio.id
      from public.portfolios as portfolio
      where portfolio.deleted_at is not null
        and portfolio.purge_after is not null
        and portfolio.purge_after <= now()
      order by portfolio.purge_after
      limit effective_limit
      for update skip locked
    ) as candidate;

    if array_length(doomed, 1) is not null then
      update public.portfolio_transactions as entry
      set counterparty_portfolio_id = null
      where entry.counterparty_portfolio_id = any (doomed)
        and not (entry.portfolio_id = any (doomed));

      delete from public.portfolio_transactions where portfolio_id = any (doomed);
      delete from public.portfolio_option_targets where portfolio_id = any (doomed);
      delete from public.portfolio_option_positions where portfolio_id = any (doomed);
      delete from public.portfolios where id = any (doomed);
      get diagnostics removed = row_count;
    end if;
  end if;

  update public.portfolio_purge_runs as target
  set scanned = due_count, purged = removed, finished_at = now()
  where target.run_id = effective_run_id;

  return query select effective_run_id, effective_mode, due_count, removed, false;
end;
$$;

revoke all on function public.purge_deleted_portfolios(uuid, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.purge_deleted_portfolios(uuid, boolean, integer) to service_role;

-- Operator visibility: what is waiting, and when the sweep last ran. Counts and
-- portfolio names for one account at a time, never a ledger.
create or replace function public.portfolio_purge_status()
returns table (
  due_now integer,
  waiting integer,
  scheduled boolean,
  last_run_at timestamptz,
  last_run_mode text,
  last_run_purged integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  job_scheduled boolean := false;
begin
  -- Probed by relation, not by function name: `cron.schedule` is overloaded and
  -- `to_regproc` cannot represent an overloaded name, so it reports NULL for a
  -- perfectly present extension. A relation resolves or it does not.
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)'
      into job_scheduled using 'portkheaw-portfolio-purge';
  end if;

  return query
  select
    (select count(*)::integer from public.portfolios as portfolio
      where portfolio.deleted_at is not null and portfolio.purge_after <= now()),
    (select count(*)::integer from public.portfolios as portfolio
      where portfolio.deleted_at is not null and portfolio.purge_after > now()),
    job_scheduled,
    (select run.started_at from public.portfolio_purge_runs as run order by run.started_at desc limit 1),
    (select run.mode from public.portfolio_purge_runs as run order by run.started_at desc limit 1),
    (select run.purged from public.portfolio_purge_runs as run order by run.started_at desc limit 1);
end;
$$;

revoke all on function public.portfolio_purge_status() from public, anon, authenticated;
grant execute on function public.portfolio_purge_status() to service_role;

-- ---------------------------------------------------------------------------
-- 7. The schedule
-- ---------------------------------------------------------------------------
do $$
declare
  existing_job_id bigint;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; the portfolio purge is not scheduled.';
    return;
  end if;

  select jobid into existing_job_id
  from cron.job where jobname = 'portkheaw-portfolio-purge' limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'portkheaw-portfolio-purge',
    '41 19 * * *',
    'select public.purge_deleted_portfolios(gen_random_uuid(), true, 100)'
  );

  raise notice 'portfolio purge scheduled: portkheaw-portfolio-purge at 19:41 UTC.';
end;
$$;

commit;
