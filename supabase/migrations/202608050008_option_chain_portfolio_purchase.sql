begin;

-- A derived balance, never a second stored balance. The ledger remains the
-- source of truth; this helper exists so the chain purchase path can make its
-- insufficient-cash decision while holding the portfolio row lock.
create or replace function public.portfolio_cash_balance_usd(target_portfolio uuid)
returns numeric
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(sum(case
    when transaction.transaction_type in ('deposit', 'dividend', 'adjustment', 'transfer_in')
      then coalesce(transaction.normalized_amount_usd, 0)
    when transaction.transaction_type in ('withdrawal', 'fee', 'transfer_out')
      then -coalesce(transaction.normalized_amount_usd, 0)
    when transaction.transaction_type = 'initial_position'
      then coalesce(transaction.normalized_amount_usd, 0)
    when transaction.transaction_type = 'acquisition'
      then -(transaction.quantity * transaction.normalized_price_usd + coalesce(transaction.normalized_fee_usd, 0))
    when transaction.transaction_type = 'disposal'
      then transaction.quantity * transaction.normalized_price_usd - coalesce(transaction.normalized_fee_usd, 0)
    when transaction.transaction_type in ('buy_to_open', 'buy_to_close')
      then -(transaction.quantity * transaction.multiplier * transaction.normalized_price_usd + coalesce(transaction.normalized_fee_usd, 0))
    when transaction.transaction_type in ('sell_to_open', 'sell_to_close')
      then transaction.quantity * transaction.multiplier * transaction.normalized_price_usd - coalesce(transaction.normalized_fee_usd, 0)
    when transaction.transaction_type = 'exercise' and transaction.option_kind = 'call'
      then -(transaction.quantity * transaction.multiplier * transaction.strike_price + coalesce(transaction.normalized_fee_usd, 0))
    when transaction.transaction_type = 'exercise' and transaction.option_kind = 'put'
      then transaction.quantity * transaction.multiplier * transaction.strike_price - coalesce(transaction.normalized_fee_usd, 0)
    when transaction.transaction_type = 'assignment' and transaction.option_kind = 'call'
      then transaction.quantity * transaction.multiplier * transaction.strike_price - coalesce(transaction.normalized_fee_usd, 0)
    when transaction.transaction_type = 'assignment' and transaction.option_kind = 'put'
      then -(transaction.quantity * transaction.multiplier * transaction.strike_price + coalesce(transaction.normalized_fee_usd, 0))
    else 0
  end), 0)::numeric
  from public.portfolio_transactions as transaction
  where transaction.portfolio_id = target_portfolio
$$;

revoke all on function public.portfolio_cash_balance_usd(uuid) from public, anon, authenticated;

-- The browser never calls the generic ledger writer for Chain -> Portfolio.
-- This narrow routine serializes on the portfolio, preserves the existing
-- effective-access/type/ledger assertions, rejects insufficient cash and then
-- delegates the actual write to the canonical ledger RPC.
create or replace function public.create_portfolio_option_purchase(
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
  input_idempotency_key uuid
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  owned_portfolio public.portfolios%rowtype;
  existing public.portfolio_transactions%rowtype;
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

  select transaction.* into existing
  from public.portfolio_transactions as transaction
  where transaction.portfolio_id = input_portfolio_id
    and transaction.idempotency_key = input_idempotency_key;
  if found then
    if existing.transaction_type = 'buy_to_open'
      and existing.underlying_symbol = upper(trim(input_underlying_symbol))
      and existing.contract_symbol = upper(trim(input_contract_symbol))
      and existing.option_kind = input_option_kind
      and existing.option_side = 'long'
      and existing.strike_price = input_strike_price
      and existing.expiration_date = input_expiration_date
      and existing.quantity = input_contracts
      and existing.normalized_price_usd = input_purchase_price
      and existing.multiplier = 100
      and existing.occurred_at_time = input_occurred_at
    then
      return existing.id;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  available_cash := public.portfolio_cash_balance_usd(input_portfolio_id);
  required_cash := input_contracts * 100 * input_purchase_price;
  if available_cash < required_cash then
    raise exception 'INSUFFICIENT_CASH:%:%', available_cash, required_cash using errcode = 'P0001';
  end if;

  result_id := public.create_portfolio_ledger_transaction(
    input_portfolio_id,
    'buy_to_open', null, input_contracts, input_purchase_price,
    null, 0, 'USD', null, input_occurred_at, null,
    input_underlying_symbol, input_contract_symbol, input_option_kind, 'long',
    input_strike_price, input_expiration_date, 100,
    'Options Chain quote ' || input_quote_timestamp::text,
    input_idempotency_key
  );
  return result_id;
end;
$$;

revoke all on function public.create_portfolio_option_purchase(
  uuid,text,text,text,numeric,date,integer,numeric,timestamptz,timestamptz,uuid
) from public, anon;
grant execute on function public.create_portfolio_option_purchase(
  uuid,text,text,text,numeric,date,integer,numeric,timestamptz,timestamptz,uuid
) to authenticated;

commit;
