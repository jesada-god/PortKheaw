begin;

-- Keep one immutable ledger for cash, securities and every option lifecycle event.
alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_transaction_type_check,
  drop constraint if exists portfolio_transactions_fields,
  drop constraint if exists portfolio_transactions_currency_metadata,
  drop constraint if exists portfolio_transactions_broker_check,
  drop constraint if exists portfolio_transactions_option_identity_check,
  drop constraint if exists portfolio_transactions_contract_symbol_check;

alter table public.portfolio_transactions
  add column if not exists normalized_price_usd numeric(28,8),
  add column if not exists fee numeric(28,8),
  add column if not exists normalized_fee_usd numeric(28,8),
  add column if not exists broker text,
  add column if not exists occurred_at_time timestamptz,
  add column if not exists underlying_symbol text,
  add column if not exists contract_symbol text,
  add column if not exists option_kind text,
  add column if not exists option_side text,
  add column if not exists strike_price numeric(28,8),
  add column if not exists expiration_date date,
  add column if not exists multiplier numeric(28,8);

update public.portfolio_transactions
set normalized_price_usd = price,
    fee = case when transaction_type in ('acquisition', 'disposal') then 0 else null end,
    normalized_fee_usd = case when transaction_type in ('acquisition', 'disposal') then 0 else null end,
    occurred_at_time = occurred_at::timestamp at time zone 'Asia/Bangkok'
where occurred_at_time is null;

alter table public.portfolio_transactions
  alter column occurred_at_time set not null;

alter table public.portfolio_transactions
  add constraint portfolio_transactions_transaction_type_check check (
    transaction_type in (
      'acquisition', 'disposal', 'initial_position',
      'dividend', 'deposit', 'withdrawal', 'fee', 'adjustment',
      'buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close',
      'exercise', 'assignment', 'expired'
    )
  ),
  add constraint portfolio_transactions_broker_check check (broker is null or char_length(broker) <= 100),
  add constraint portfolio_transactions_option_identity_check check (
    underlying_symbol is null or (
      underlying_symbol = upper(trim(underlying_symbol))
      and underlying_symbol ~ '^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]{0,19})$'
    )
  ),
  add constraint portfolio_transactions_contract_symbol_check check (
    contract_symbol is null or (
      contract_symbol = upper(trim(contract_symbol))
      and contract_symbol ~ '^[A-Z0-9][A-Z0-9._:-]{2,79}$'
    )
  ),
  add constraint portfolio_transactions_currency_metadata check (
    original_currency in ('USD', 'THB')
    and (
      (amount is null and original_amount is null and normalized_amount_usd is null)
      or
      (amount is not null and original_amount is not null and normalized_amount_usd is not null)
    )
    and (
      (price is null and normalized_price_usd is null)
      or
      (price is not null and normalized_price_usd is not null)
    )
    and (
      (fee is null and normalized_fee_usd is null)
      or
      (fee is not null and fee >= 0 and normalized_fee_usd is not null and normalized_fee_usd >= 0)
    )
    and (
      (original_currency = 'USD' and fx_rate_at_transaction is null)
      or (original_currency = 'THB' and fx_rate_at_transaction > 0)
    )
  ),
  add constraint portfolio_transactions_fields check (
    (
      transaction_type in ('acquisition', 'disposal')
      and symbol is not null and quantity > 0 and price > 0 and amount is null and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or
    (
      transaction_type = 'initial_position'
      and symbol is not null and quantity > 0 and price > 0 and amount >= 0 and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or
    (
      transaction_type in ('dividend', 'deposit', 'withdrawal', 'fee')
      and quantity is null and price is null and amount > 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or
    (
      transaction_type = 'adjustment'
      and quantity is null and price is null and amount <> 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or
    (
      transaction_type in ('buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired')
      and symbol is null and quantity > 0 and price >= 0 and amount is null and fee >= 0
      and underlying_symbol is not null and contract_symbol is not null
      and option_kind in ('call', 'put') and option_side in ('long', 'short')
      and strike_price > 0 and expiration_date is not null and multiplier > 0
      and (transaction_type in ('exercise', 'assignment', 'expired') or price > 0)
      and (transaction_type not in ('buy_to_open', 'sell_to_close', 'exercise') or option_side = 'long')
      and (transaction_type not in ('sell_to_open', 'buy_to_close', 'assignment') or option_side = 'short')
    )
  );

drop index if exists portfolio_transactions_ledger_order_idx;
drop index if exists portfolio_transactions_option_identity_idx;
create index portfolio_transactions_ledger_order_idx
  on public.portfolio_transactions (portfolio_id, occurred_at_time, created_at, id);
create index portfolio_transactions_option_identity_idx
  on public.portfolio_transactions (portfolio_id, contract_symbol, occurred_at_time, id)
  where contract_symbol is not null;

-- Existing Phase 4 option rows represented long entries only. Convert open rows
-- once without inventing a closing premium for closed legacy rows.
insert into public.portfolio_transactions (
  portfolio_id, transaction_type, quantity, price, normalized_price_usd, amount,
  fee, normalized_fee_usd, original_currency, occurred_at, occurred_at_time,
  underlying_symbol, contract_symbol, option_kind, option_side, strike_price,
  expiration_date, multiplier, note, broker, idempotency_key, created_at, updated_at
)
select
  legacy.portfolio_id, 'buy_to_open', legacy.contracts, legacy.premium_per_share,
  legacy.premium_per_share, null, 0, 0, 'USD', legacy.opened_at,
  legacy.opened_at::timestamp at time zone 'Asia/Bangkok',
  legacy.underlying_symbol, upper('LEGACY-' || legacy.id::text), legacy.option_kind, 'long',
  legacy.strike_price, legacy.expiration_date, 100, legacy.note, null, legacy.id,
  legacy.created_at, legacy.updated_at
from public.portfolio_option_positions as legacy
where legacy.status = 'open'
on conflict (portfolio_id, idempotency_key) do nothing;

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
      option_delta := case
        when row_record.transaction_type = 'buy_to_open' then row_record.quantity
        when row_record.transaction_type = 'sell_to_open' then -row_record.quantity
        when row_record.transaction_type in ('sell_to_close', 'exercise') then -row_record.quantity
        when row_record.transaction_type in ('buy_to_close', 'assignment') then row_record.quantity
        when row_record.transaction_type = 'expired' and row_record.option_side = 'long' then -row_record.quantity
        when row_record.transaction_type = 'expired' and row_record.option_side = 'short' then row_record.quantity
        else 0
      end;
      if row_record.transaction_type = 'buy_to_open' and option_available < 0 then
        raise exception 'Cannot open a long lot while a short lot remains for %', row_record.contract_symbol using errcode = '23514';
      end if;
      if row_record.transaction_type = 'sell_to_open' and option_available > 0 then
        raise exception 'Cannot open a short lot while a long lot remains for %', row_record.contract_symbol using errcode = '23514';
      end if;
      if row_record.transaction_type in ('sell_to_close', 'exercise')
         or (row_record.transaction_type = 'expired' and row_record.option_side = 'long') then
        if row_record.quantity > option_available then
          raise exception 'Option close exceeds available long contracts for %', row_record.contract_symbol using errcode = '23514';
        end if;
      end if;
      if row_record.transaction_type in ('buy_to_close', 'assignment')
         or (row_record.transaction_type = 'expired' and row_record.option_side = 'short') then
        if row_record.quantity > -option_available then
          raise exception 'Option close exceeds available short contracts for %', row_record.contract_symbol using errcode = '23514';
        end if;
      end if;
      option_balances := jsonb_set(option_balances, array[row_record.contract_symbol], to_jsonb(option_available + option_delta));
    end if;
  end loop;
end;
$$;

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

create or replace function public.delete_portfolio_ledger_transaction(transaction_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid;
begin
  select transaction.portfolio_id into target_portfolio
  from public.portfolio_transactions as transaction
  join public.portfolios as portfolio on portfolio.id = transaction.portfolio_id
  where transaction.id = transaction_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  perform 1 from public.portfolios where id = target_portfolio for update;
  delete from public.portfolio_transactions where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

revoke all on function public.create_portfolio_ledger_transaction(text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) from public, anon;
revoke all on function public.update_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text) from public, anon;
revoke all on function public.delete_portfolio_ledger_transaction(uuid) from public, anon;
grant execute on function public.create_portfolio_ledger_transaction(text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) to authenticated;
grant execute on function public.update_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text) to authenticated;
grant execute on function public.delete_portfolio_ledger_transaction(uuid) to authenticated;

create table if not exists public.portfolio_option_targets (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  contract_symbol text not null check (
    contract_symbol = upper(trim(contract_symbol))
    and contract_symbol ~ '^[A-Z0-9][A-Z0-9._:-]{2,79}$'
  ),
  side text not null check (side in ('long', 'short')),
  mode text not null check (mode in ('premium', 'profit_percent')),
  target_value numeric(28,8) not null check (target_value >= 0),
  target_premium numeric(28,8) not null check (target_premium >= 0),
  estimated_fee numeric(28,8) not null default 0 check (estimated_fee >= 0),
  enabled boolean not null default true,
  triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portfolio_id, contract_symbol)
);

create index if not exists portfolio_option_targets_enabled_idx
  on public.portfolio_option_targets (portfolio_id, enabled, created_at desc);
alter table public.portfolio_option_targets enable row level security;
drop policy if exists "Users can read own option targets" on public.portfolio_option_targets;
create policy "Users can read own option targets" on public.portfolio_option_targets
  for select to authenticated
  using (exists (select 1 from public.portfolios as portfolio where portfolio.id = portfolio_id and portfolio.user_id = (select auth.uid())));
revoke insert, update, delete on public.portfolio_option_targets from authenticated;

create or replace function public.upsert_portfolio_option_target(
  input_id uuid, input_contract_symbol text, input_side text, input_mode text,
  input_target_value numeric, input_target_premium numeric, input_estimated_fee numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid; result_id uuid;
begin
  target_portfolio := public.get_or_create_default_portfolio();
  perform 1 from public.portfolios where id = target_portfolio and user_id = (select auth.uid()) for update;
  if input_id is null then
    insert into public.portfolio_option_targets (
      portfolio_id, contract_symbol, side, mode, target_value, target_premium, estimated_fee
    ) values (
      target_portfolio, upper(trim(input_contract_symbol)), input_side, input_mode,
      input_target_value, input_target_premium, input_estimated_fee
    )
    on conflict (portfolio_id, contract_symbol) do update set
      side = excluded.side, mode = excluded.mode, target_value = excluded.target_value, target_premium = excluded.target_premium,
      estimated_fee = excluded.estimated_fee, enabled = true, triggered_at = null, updated_at = now()
    returning id into result_id;
  else
    update public.portfolio_option_targets set
      side = input_side, mode = input_mode, target_value = input_target_value, target_premium = input_target_premium,
      estimated_fee = input_estimated_fee, enabled = true, triggered_at = null, updated_at = now()
    where id = input_id and portfolio_id = target_portfolio
    returning id into result_id;
    if result_id is null then raise exception 'Option target not found' using errcode = '42501'; end if;
  end if;
  return result_id;
end;
$$;

create or replace function public.delete_portfolio_option_target(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.portfolio_option_targets as target
  using public.portfolios as portfolio
  where target.id = target_id and portfolio.id = target.portfolio_id and portfolio.user_id = (select auth.uid());
  if not found then raise exception 'Option target not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.evaluate_portfolio_option_target(
  target_id uuid, observed_premium numeric, observed_at timestamptz,
  notification_title text, notification_message text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare owned_target public.portfolio_option_targets%rowtype; requesting_user uuid := (select auth.uid()); result_id uuid;
begin
  select target.* into owned_target
  from public.portfolio_option_targets as target
  join public.portfolios as portfolio on portfolio.id = target.portfolio_id
  where target.id = target_id and portfolio.user_id = requesting_user and target.enabled = true
  for update;
  if not found or owned_target.triggered_at is not null then return null; end if;
  if (owned_target.side = 'long' and observed_premium < owned_target.target_premium)
     or (owned_target.side = 'short' and observed_premium > owned_target.target_premium)
  then return null; end if;
  insert into public.notifications (user_id, type, title, message, metadata)
  values (
    requesting_user, 'system', notification_title, notification_message,
    jsonb_build_object(
      'kind', 'option_target', 'targetId', owned_target.id,
      'contractSymbol', owned_target.contract_symbol, 'observedPremium', observed_premium,
      'targetPremium', owned_target.target_premium, 'observedAt', observed_at
    )
  ) returning id into result_id;
  update public.portfolio_option_targets
  set triggered_at = observed_at, enabled = false, updated_at = now()
  where id = owned_target.id;
  return result_id;
end;
$$;

revoke all on function public.upsert_portfolio_option_target(uuid,text,text,text,numeric,numeric,numeric) from public, anon;
revoke all on function public.delete_portfolio_option_target(uuid) from public, anon;
revoke all on function public.evaluate_portfolio_option_target(uuid,numeric,timestamptz,text,text) from public, anon;
grant execute on function public.upsert_portfolio_option_target(uuid,text,text,text,numeric,numeric,numeric) to authenticated;
grant execute on function public.delete_portfolio_option_target(uuid) to authenticated;
grant execute on function public.evaluate_portfolio_option_target(uuid,numeric,timestamptz,text,text) to authenticated;

commit;
