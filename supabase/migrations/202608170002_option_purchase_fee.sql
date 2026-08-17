begin;

-- ===========================================================================
-- The fee is part of what the order cost, so the order writes it
-- ===========================================================================
--
-- Buying a contract from the chain wrote `0` into the ledger's fee column, not
-- because the purchase was free but because the sheet had nowhere to say
-- otherwise. Every figure the ledger derives from a `buy_to_open` row —
-- remaining cost, unrealized P&L, realized P&L on the close, the cash balance —
-- was therefore short by exactly the commission the broker actually charged, and
-- silently: a position that had lost the fee read as break-even.
--
-- Nothing about how a fee is *accounted* changes here. `create_portfolio_ledger_transaction`
-- has always taken a fee, `portfolio_cash_balance_usd` has always subtracted it
-- on a `buy_to_open`, and `calculateOptionLedger` has always folded it into the
-- opening cost so a partial close keeps its proportional basis. What changes is
-- that this path now has a fee to pass them, instead of a hardcoded zero.
--
-- Two columns' worth of new information, and only one of them is money:
--
--   * `input_fee` is the whole order's fee in USD, already resolved. When the
--     reader types a per-contract fee the *application* multiplies it out before
--     calling this, so exactly one number is ever stored and no reader of the
--     ledger has to know a mode existed to get the cost right.
--   * `fee_mode` records how that number was typed, and is deliberately inert.
--     No calculation reads it, no gate depends on it, and a row that lacks it —
--     which is every row written before today — means 'total', which is what a
--     single stored fee always was. It exists so the sheet can say where the
--     figure came from; it must never become a second source of truth about
--     money, because a mode disagreeing with a total would make the cost
--     ambiguous.
--
-- Both are optional at the boundary. `input_fee` defaults to 0 and
-- `input_fee_mode` to 'total', so a client that predates the fee box keeps
-- working and writes precisely what it wrote before.
--
-- The fee is refused below zero. A negative fee is a rebate, the ledger has no
-- verb for one, and admitting it here would let a purchase *add* cash through a
-- column every balance treats as a subtraction. It is also charged against the
-- cash check: an order the reader cannot afford once commission is counted is
-- refused before the row exists, by the same comparison that already held the
-- portfolio row lock.
--
-- Additive and forward-only. The column is nullable with no backfill, because
-- the absence of a mode is already the correct reading of an existing row. The
-- routine is dropped and recreated only because appending parameters changes a
-- function's identity, which `create or replace` cannot do; its admin-free
-- ownership check, its `security definer` boundary, its idempotency contract and
-- its grants are unchanged.

-- How the fee on a row was entered. Never how much it was — that is `fee`.
alter table public.portfolio_transactions
  add column if not exists fee_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portfolio_transactions'::regclass
      and conname = 'portfolio_transactions_fee_mode_check'
  ) then
    alter table public.portfolio_transactions
      add constraint portfolio_transactions_fee_mode_check
      check (fee_mode is null or fee_mode in ('total', 'per_contract'));
  end if;
end
$$;

comment on column public.portfolio_transactions.fee_mode is
  'How the fee on this row was entered (total | per_contract). Presentation only: fee is always the whole order''s, and null means total.';

drop function if exists public.create_portfolio_option_purchase(
  uuid,text,text,text,numeric,date,integer,numeric,timestamptz,timestamptz,uuid
);

create function public.create_portfolio_option_purchase(
  input_portfolio_id uuid,
  input_underlying_symbol text,
  input_contract_symbol text,
  input_option_kind text,
  input_strike_price numeric,
  input_expiration_date date,
  input_contracts integer,
  input_purchase_price numeric,
  input_occurred_at timestamptz,
  input_quote_timestamp timestamptz,
  input_idempotency_key uuid,
  input_fee numeric default 0,
  input_fee_mode text default 'total'
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  owned_portfolio public.portfolios%rowtype;
  existing public.portfolio_transactions%rowtype;
  order_fee numeric(28,8) := coalesce(input_fee, 0);
  fee_mode_value text := coalesce(nullif(trim(input_fee_mode), ''), 'total');
  required_cash numeric(28,8);
  available_cash numeric(28,8);
  result_id uuid;
begin
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = input_portfolio_id
    and portfolio.user_id = (select auth.uid())
  for update;
  if not found then
    raise exception 'Portfolio not found' using errcode = '42501';
  end if;

  perform public.assert_portfolio_accepts_transaction(input_portfolio_id, 'buy_to_open', true);
  if owned_portfolio.portfolio_type <> 'OPTION' then
    raise exception 'Option Chain purchases require an Options portfolio' using errcode = '23514';
  end if;
  if input_contracts <= 0 or input_purchase_price <= 0 then
    raise exception 'Invalid option purchase quantity or price' using errcode = '22023';
  end if;
  -- A fee is a charge or it is nothing. Below zero it would credit the portfolio
  -- through a column every balance subtracts.
  if order_fee < 0 then
    raise exception 'Invalid option purchase fee' using errcode = '22023';
  end if;
  if fee_mode_value not in ('total', 'per_contract') then
    raise exception 'Invalid option purchase fee mode' using errcode = '22023';
  end if;

  select transaction.* into existing
  from public.portfolio_transactions as transaction
  where transaction.portfolio_id = input_portfolio_id
    and transaction.idempotency_key = input_idempotency_key;
  if found then
    -- The fee joins the terms a replay has to match. Two orders that differ only
    -- by commission are two different charges against the same cash.
    if existing.transaction_type = 'buy_to_open'
      and existing.underlying_symbol = upper(trim(input_underlying_symbol))
      and existing.contract_symbol = upper(trim(input_contract_symbol))
      and existing.option_kind = input_option_kind
      and existing.option_side = 'long'
      and existing.strike_price = input_strike_price
      and existing.expiration_date = input_expiration_date
      and existing.quantity = input_contracts
      and existing.normalized_price_usd = input_purchase_price
      and coalesce(existing.normalized_fee_usd, 0) = order_fee
      and existing.multiplier = 100
      and existing.occurred_at_time = input_occurred_at
    then
      return existing.id;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  available_cash := public.portfolio_cash_balance_usd(input_portfolio_id);
  required_cash := input_contracts * 100 * input_purchase_price + order_fee;
  if available_cash < required_cash then
    raise exception 'INSUFFICIENT_CASH:%:%', available_cash, required_cash using errcode = 'P0001';
  end if;

  result_id := public.create_portfolio_ledger_transaction(
    input_portfolio_id,
    'buy_to_open', null, input_contracts, input_purchase_price,
    null, order_fee, 'USD', null, input_occurred_at, null,
    input_underlying_symbol, input_contract_symbol, input_option_kind, 'long',
    input_strike_price, input_expiration_date, 100,
    'Options Chain quote ' || input_quote_timestamp::text,
    input_idempotency_key
  );
  -- Stamped after the canonical write rather than threaded through it: the
  -- generic ledger routine is shared by every transaction path, and a note about
  -- how one sheet's fee box was filled in has no business in its signature.
  update public.portfolio_transactions
  set fee_mode = fee_mode_value
  where id = result_id;
  return result_id;
end;
$$;

revoke all on function public.create_portfolio_option_purchase(
  uuid,text,text,text,numeric,date,integer,numeric,timestamptz,timestamptz,uuid,numeric,text
) from public, anon;
grant execute on function public.create_portfolio_option_purchase(
  uuid,text,text,text,numeric,date,integer,numeric,timestamptz,timestamptz,uuid,numeric,text
) to authenticated;

commit;
