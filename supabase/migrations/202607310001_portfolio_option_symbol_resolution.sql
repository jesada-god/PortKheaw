begin;

-- A contract resolved by the provider must replace every internal identifier for
-- the same option identity before ledger validation runs. This keeps opening and
-- closing events on one key without changing any portfolio or P&L formula.
create or replace function public.canonicalize_portfolio_option_contract(
  target_portfolio uuid,
  input_underlying_symbol text,
  input_option_kind text,
  input_strike_price numeric,
  input_expiration_date date,
  input_contract_symbol text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  unresolved_symbol text;
  canonical_symbol text := upper(trim(input_contract_symbol));
begin
  if canonical_symbol is null
     or canonical_symbol like 'UNRESOLVED-%'
     or canonical_symbol like 'LEGACY-%' then
    return;
  end if;

  for unresolved_symbol in
    select distinct transaction.contract_symbol
    from public.portfolio_transactions as transaction
    where transaction.portfolio_id = target_portfolio
      and transaction.underlying_symbol = upper(trim(input_underlying_symbol))
      and transaction.option_kind = input_option_kind
      and transaction.strike_price = input_strike_price
      and transaction.expiration_date = input_expiration_date
      and transaction.contract_symbol like 'UNRESOLVED-%'
      and transaction.contract_symbol <> canonical_symbol
  loop
    if exists (
      select 1 from public.portfolio_option_targets as target
      where target.portfolio_id = target_portfolio
        and target.contract_symbol = canonical_symbol
    ) then
      delete from public.portfolio_option_targets as target
      where target.portfolio_id = target_portfolio
        and target.contract_symbol = unresolved_symbol;
    else
      update public.portfolio_option_targets as target
      set contract_symbol = canonical_symbol, updated_at = now()
      where target.portfolio_id = target_portfolio
        and target.contract_symbol = unresolved_symbol;
    end if;
  end loop;

  update public.portfolio_transactions as transaction
  set contract_symbol = canonical_symbol, updated_at = now()
  where transaction.portfolio_id = target_portfolio
    and transaction.underlying_symbol = upper(trim(input_underlying_symbol))
    and transaction.option_kind = input_option_kind
    and transaction.strike_price = input_strike_price
    and transaction.expiration_date = input_expiration_date
    and transaction.contract_symbol like 'UNRESOLVED-%'
    and transaction.contract_symbol <> canonical_symbol;
end;
$$;

revoke all on function public.canonicalize_portfolio_option_contract(uuid,text,text,numeric,date,text) from public, anon, authenticated;

create or replace function public.create_portfolio_ledger_transaction(
  input_type text, input_symbol text, input_quantity numeric, input_price numeric,
  input_amount numeric, input_fee numeric, input_original_currency text,
  input_fx_rate_at_transaction numeric, input_occurred_at timestamptz, input_broker text,
  input_underlying_symbol text, input_contract_symbol text, input_option_kind text,
  input_option_side text, input_strike_price numeric, input_expiration_date date,
  input_multiplier numeric, input_note text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target_portfolio uuid;
  result_id uuid;
  normalized_amount numeric(28,8);
  normalized_price numeric(28,8);
  normalized_fee numeric(28,8);
begin
  target_portfolio := public.get_or_create_default_portfolio();
  perform 1 from public.portfolios where id = target_portfolio and user_id = (select auth.uid()) for update;
  normalized_amount := case when input_amount is null then null when input_original_currency = 'USD' then input_amount else round(input_amount / input_fx_rate_at_transaction, 8) end;
  normalized_price := case when input_price is null then null when input_original_currency = 'USD' then input_price else round(input_price / input_fx_rate_at_transaction, 8) end;
  normalized_fee := case when input_fee is null then null when input_original_currency = 'USD' then input_fee else round(input_fee / input_fx_rate_at_transaction, 8) end;

  if input_type in ('buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired') then
    perform public.canonicalize_portfolio_option_contract(
      target_portfolio, input_underlying_symbol, input_option_kind, input_strike_price,
      input_expiration_date, input_contract_symbol
    );
  end if;

  insert into public.portfolio_transactions (
    portfolio_id, transaction_type, symbol, quantity, price, amount, original_amount,
    original_currency, fx_rate_at_transaction, normalized_amount_usd, normalized_price_usd,
    fee, normalized_fee_usd, occurred_at, occurred_at_time, broker, underlying_symbol,
    contract_symbol, option_kind, option_side, strike_price, expiration_date, multiplier,
    note, idempotency_key
  ) values (
    target_portfolio, input_type, nullif(upper(trim(input_symbol)), ''), input_quantity,
    input_price, input_amount, input_amount, input_original_currency, input_fx_rate_at_transaction,
    normalized_amount, normalized_price, input_fee, normalized_fee,
    (input_occurred_at at time zone 'Asia/Bangkok')::date, input_occurred_at,
    nullif(trim(input_broker), ''), nullif(upper(trim(input_underlying_symbol)), ''),
    nullif(upper(trim(input_contract_symbol)), ''), input_option_kind, input_option_side,
    input_strike_price, input_expiration_date, input_multiplier, nullif(trim(input_note), ''),
    input_idempotency_key
  )
  on conflict (portfolio_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into result_id;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
  return result_id;
end;
$$;

create or replace function public.update_portfolio_ledger_transaction(
  transaction_id uuid, input_type text, input_symbol text, input_quantity numeric,
  input_price numeric, input_amount numeric, input_fee numeric, input_original_currency text,
  input_fx_rate_at_transaction numeric, input_occurred_at timestamptz, input_broker text,
  input_underlying_symbol text, input_contract_symbol text, input_option_kind text,
  input_option_side text, input_strike_price numeric, input_expiration_date date,
  input_multiplier numeric, input_note text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  target_portfolio uuid;
  normalized_amount numeric(28,8);
  normalized_price numeric(28,8);
  normalized_fee numeric(28,8);
begin
  select transaction.portfolio_id into target_portfolio
  from public.portfolio_transactions as transaction
  join public.portfolios as portfolio on portfolio.id = transaction.portfolio_id
  where transaction.id = transaction_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  perform 1 from public.portfolios where id = target_portfolio for update;
  normalized_amount := case when input_amount is null then null when input_original_currency = 'USD' then input_amount else round(input_amount / input_fx_rate_at_transaction, 8) end;
  normalized_price := case when input_price is null then null when input_original_currency = 'USD' then input_price else round(input_price / input_fx_rate_at_transaction, 8) end;
  normalized_fee := case when input_fee is null then null when input_original_currency = 'USD' then input_fee else round(input_fee / input_fx_rate_at_transaction, 8) end;

  if input_type in ('buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired') then
    perform public.canonicalize_portfolio_option_contract(
      target_portfolio, input_underlying_symbol, input_option_kind, input_strike_price,
      input_expiration_date, input_contract_symbol
    );
  end if;

  update public.portfolio_transactions set
    transaction_type = input_type, symbol = nullif(upper(trim(input_symbol)), ''),
    quantity = input_quantity, price = input_price, amount = input_amount,
    original_amount = input_amount, original_currency = input_original_currency,
    fx_rate_at_transaction = input_fx_rate_at_transaction, normalized_amount_usd = normalized_amount,
    normalized_price_usd = normalized_price, fee = input_fee, normalized_fee_usd = normalized_fee,
    occurred_at = (input_occurred_at at time zone 'Asia/Bangkok')::date,
    occurred_at_time = input_occurred_at, broker = nullif(trim(input_broker), ''),
    underlying_symbol = nullif(upper(trim(input_underlying_symbol)), ''),
    contract_symbol = nullif(upper(trim(input_contract_symbol)), ''),
    option_kind = input_option_kind, option_side = input_option_side,
    strike_price = input_strike_price, expiration_date = input_expiration_date,
    multiplier = input_multiplier, note = nullif(trim(input_note), ''), updated_at = now()
  where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

revoke all on function public.create_portfolio_ledger_transaction(text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) from public, anon;
revoke all on function public.update_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text) from public, anon;
grant execute on function public.create_portfolio_ledger_transaction(text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) to authenticated;
grant execute on function public.update_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text) to authenticated;

commit;
