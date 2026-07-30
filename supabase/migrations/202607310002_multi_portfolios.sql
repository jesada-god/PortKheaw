begin;

-- Extend the existing portfolio and transaction-ledger model. Existing rows
-- become one non-counting LEGACY portfolio per user and are never split,
-- duplicated, re-parented or deleted by this migration.
alter table public.portfolios
  drop constraint if exists portfolios_one_per_user,
  drop constraint if exists portfolios_name_check,
  drop constraint if exists portfolios_type_check,
  drop constraint if exists portfolios_legacy_type_check,
  drop constraint if exists portfolios_goal_check;

alter table public.portfolios
  add column if not exists portfolio_type text not null default 'LEGACY',
  add column if not exists is_legacy boolean not null default true,
  add column if not exists archived_at timestamptz,
  add column if not exists target_value_usd numeric(28,8),
  add column if not exists target_date date;

-- Defaults change only after PostgreSQL has backfilled pre-existing rows.
alter table public.portfolios
  alter column portfolio_type set default 'STOCK',
  alter column is_legacy set default false;

alter table public.portfolios
  add constraint portfolios_type_check check (portfolio_type in ('STOCK', 'OPTION', 'LEGACY')),
  add constraint portfolios_legacy_type_check check ((portfolio_type = 'LEGACY') = is_legacy),
  add constraint portfolios_name_check check (
    char_length(btrim(name)) between 1 and case when is_legacy then 80 else 40 end
  ),
  add constraint portfolios_goal_check check (
    (target_value_usd is null and target_date is null)
    or target_value_usd > 0
  );

create unique index if not exists portfolios_owner_type_normalized_name_key
  on public.portfolios (user_id, portfolio_type, lower(btrim(name)));
create unique index if not exists portfolios_one_legacy_per_user_key
  on public.portfolios (user_id) where is_legacy;
create index if not exists portfolios_owner_active_type_idx
  on public.portfolios (user_id, portfolio_type, created_at)
  where archived_at is null;

alter table public.user_settings
  add column if not exists aggregate_target_value_usd numeric(28,8),
  add column if not exists aggregate_target_date date;
alter table public.user_settings
  drop constraint if exists user_settings_aggregate_goal_check;
alter table public.user_settings
  add constraint user_settings_aggregate_goal_check check (
    (aggregate_target_value_usd is null and aggregate_target_date is null)
    or aggregate_target_value_usd > 0
  );

create or replace function public.enforce_portfolio_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare active_count integer;
begin
  if new.portfolio_type not in ('STOCK', 'OPTION') or new.archived_at is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.portfolio_type, 0));
  select count(*) into active_count
  from public.portfolios as portfolio
  where portfolio.user_id = new.user_id
    and portfolio.portfolio_type = new.portfolio_type
    and portfolio.archived_at is null
    and portfolio.id <> new.id;
  if active_count >= 10 then
    raise exception 'Portfolio limit reached for %', new.portfolio_type using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists portfolios_enforce_limit on public.portfolios;
create trigger portfolios_enforce_limit
before insert or update of portfolio_type, archived_at on public.portfolios
for each row execute function public.enforce_portfolio_limit();

revoke all on function public.enforce_portfolio_limit() from public, anon, authenticated;
revoke insert, update, delete on public.portfolios from authenticated;

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
  where portfolio.user_id = requesting_user and portfolio.is_legacy
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

create or replace function public.create_portfolio(input_name text, input_type text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare requesting_user uuid := (select auth.uid()); result_id uuid; normalized_name text := btrim(input_name);
begin
  if requesting_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if input_type not in ('STOCK', 'OPTION') then raise exception 'Unsupported portfolio type' using errcode = '22023'; end if;
  if char_length(normalized_name) not between 1 and 40 then raise exception 'Portfolio name must contain 1-40 characters' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':' || input_type, 0));
  insert into public.portfolios (user_id, name, portfolio_type, is_legacy, base_currency)
  select requesting_user, normalized_name, input_type, false, coalesce(settings.base_currency, 'USD')
  from (select 1) as seed
  left join public.user_settings as settings on settings.user_id = requesting_user
  returning id into result_id;
  return result_id;
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
  update public.portfolios
  set target_value_usd = input_target_value_usd,
      target_date = case when input_target_value_usd is null then null else input_target_date end,
      updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid());
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.set_aggregate_portfolio_goal(
  input_target_value_usd numeric, input_target_date date
) returns void language plpgsql security definer set search_path = '' as $$
declare requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if input_target_value_usd is not null and input_target_value_usd <= 0 then
    raise exception 'Target value must be greater than zero' using errcode = '22023';
  end if;
  if input_target_value_usd is null and input_target_date is not null then
    raise exception 'Target date requires a target value' using errcode = '22023';
  end if;
  insert into public.user_settings (user_id, aggregate_target_value_usd, aggregate_target_date)
  values (
    requesting_user,
    input_target_value_usd,
    case when input_target_value_usd is null then null else input_target_date end
  )
  on conflict (user_id) do update set
    aggregate_target_value_usd = excluded.aggregate_target_value_usd,
    aggregate_target_date = excluded.aggregate_target_date,
    updated_at = now();
end;
$$;

create or replace function public.archive_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.portfolios
  set archived_at = coalesce(archived_at, now()), updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid());
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

create or replace function public.restore_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.portfolios
  set archived_at = null, updated_at = now()
  where id = target_portfolio_id and user_id = (select auth.uid());
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
end;
$$;

-- Deletion is deliberately stricter than the foreign keys: a legacy portfolio,
-- ledger history, target, legacy position or non-zero derived cash all block it.
create or replace function public.delete_empty_portfolio(target_portfolio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owned_portfolio public.portfolios%rowtype; derived_cash numeric(28,8);
begin
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = (select auth.uid())
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;
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

revoke all on function public.create_portfolio(text,text) from public, anon;
revoke all on function public.update_portfolio_details(uuid,text,text) from public, anon;
revoke all on function public.set_portfolio_goal(uuid,numeric,date) from public, anon;
revoke all on function public.set_aggregate_portfolio_goal(numeric,date) from public, anon;
revoke all on function public.archive_portfolio(uuid) from public, anon;
revoke all on function public.restore_portfolio(uuid) from public, anon;
revoke all on function public.delete_empty_portfolio(uuid) from public, anon;
grant execute on function public.create_portfolio(text,text) to authenticated;
grant execute on function public.update_portfolio_details(uuid,text,text) to authenticated;
grant execute on function public.set_portfolio_goal(uuid,numeric,date) to authenticated;
grant execute on function public.set_aggregate_portfolio_goal(numeric,date) to authenticated;
grant execute on function public.archive_portfolio(uuid) to authenticated;
grant execute on function public.restore_portfolio(uuid) to authenticated;
grant execute on function public.delete_empty_portfolio(uuid) to authenticated;

-- Transfers are paired events in the one existing ledger. No transaction is
-- re-parented, and internal transfers are distinguishable from external cash.
alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_transaction_type_check,
  drop constraint if exists portfolio_transactions_fields,
  drop constraint if exists portfolio_transactions_transfer_metadata;

alter table public.portfolio_transactions
  add column if not exists transfer_id uuid,
  add column if not exists counterparty_portfolio_id uuid;

alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_counterparty_portfolio_id_fkey;
alter table public.portfolio_transactions
  add constraint portfolio_transactions_counterparty_portfolio_id_fkey
  foreign key (counterparty_portfolio_id) references public.portfolios(id) on delete restrict;

alter table public.portfolio_transactions
  add constraint portfolio_transactions_transaction_type_check check (
    transaction_type in (
      'acquisition', 'disposal', 'initial_position',
      'dividend', 'deposit', 'withdrawal', 'fee', 'adjustment',
      'transfer_out', 'transfer_in',
      'buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close',
      'exercise', 'assignment', 'expired'
    )
  ),
  add constraint portfolio_transactions_transfer_metadata check (
    (
      transaction_type in ('transfer_out', 'transfer_in')
      and transfer_id is not null
      and counterparty_portfolio_id is not null
      and counterparty_portfolio_id <> portfolio_id
    )
    or (
      transaction_type not in ('transfer_out', 'transfer_in')
      and transfer_id is null
      and counterparty_portfolio_id is null
    )
  ),
  add constraint portfolio_transactions_fields check (
    (
      transaction_type in ('acquisition', 'disposal')
      and symbol is not null and quantity > 0 and price > 0 and amount is null and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or (
      transaction_type = 'initial_position'
      and symbol is not null and quantity > 0 and price > 0 and amount >= 0 and fee >= 0
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or (
      transaction_type in ('dividend', 'deposit', 'withdrawal', 'fee', 'transfer_out', 'transfer_in')
      and symbol is null and quantity is null and price is null and amount > 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or (
      transaction_type = 'adjustment'
      and symbol is null and quantity is null and price is null and amount <> 0 and fee is null
      and underlying_symbol is null and contract_symbol is null and option_kind is null and option_side is null
      and strike_price is null and expiration_date is null and multiplier is null
    )
    or (
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

create unique index if not exists portfolio_transactions_transfer_pair_key
  on public.portfolio_transactions (transfer_id, transaction_type)
  where transfer_id is not null;

alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_portfolio_id_fkey;
alter table public.portfolio_transactions
  add constraint portfolio_transactions_portfolio_id_fkey
  foreign key (portfolio_id) references public.portfolios(id) on delete restrict;

alter table public.portfolio_option_targets
  drop constraint if exists portfolio_option_targets_portfolio_id_fkey;
alter table public.portfolio_option_targets
  add constraint portfolio_option_targets_portfolio_id_fkey
  foreign key (portfolio_id) references public.portfolios(id) on delete restrict;

alter table public.portfolio_option_positions
  drop constraint if exists portfolio_option_positions_portfolio_id_fkey;
alter table public.portfolio_option_positions
  add constraint portfolio_option_positions_portfolio_id_fkey
  foreign key (portfolio_id) references public.portfolios(id) on delete restrict;

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

create or replace function public.create_portfolio_ledger_transaction(
  input_portfolio_id uuid,
  input_type text, input_symbol text, input_quantity numeric, input_price numeric,
  input_amount numeric, input_fee numeric, input_original_currency text,
  input_fx_rate_at_transaction numeric, input_occurred_at timestamptz, input_broker text,
  input_underlying_symbol text, input_contract_symbol text, input_option_kind text,
  input_option_side text, input_strike_price numeric, input_expiration_date date,
  input_multiplier numeric, input_note text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid; normalized_amount numeric(28,8); normalized_price numeric(28,8); normalized_fee numeric(28,8);
begin
  perform public.assert_portfolio_accepts_transaction(input_portfolio_id, input_type, true);
  normalized_amount := case when input_amount is null then null when input_original_currency = 'USD' then input_amount else round(input_amount / input_fx_rate_at_transaction, 8) end;
  normalized_price := case when input_price is null then null when input_original_currency = 'USD' then input_price else round(input_price / input_fx_rate_at_transaction, 8) end;
  normalized_fee := case when input_fee is null then null when input_original_currency = 'USD' then input_fee else round(input_fee / input_fx_rate_at_transaction, 8) end;
  if input_type in ('buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired') then
    perform public.canonicalize_portfolio_option_contract(
      input_portfolio_id, input_underlying_symbol, input_option_kind, input_strike_price,
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
    input_portfolio_id, input_type, nullif(upper(trim(input_symbol)), ''), input_quantity,
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
  perform public.assert_portfolio_ledger_valid(input_portfolio_id);
  return result_id;
end;
$$;

-- Compatibility wrapper for an in-flight older deployment. It still resolves
-- an explicit portfolio id before writing through the new validated RPC.
create or replace function public.create_portfolio_ledger_transaction(
  input_type text, input_symbol text, input_quantity numeric, input_price numeric,
  input_amount numeric, input_fee numeric, input_original_currency text,
  input_fx_rate_at_transaction numeric, input_occurred_at timestamptz, input_broker text,
  input_underlying_symbol text, input_contract_symbol text, input_option_kind text,
  input_option_side text, input_strike_price numeric, input_expiration_date date,
  input_multiplier numeric, input_note text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.create_portfolio_ledger_transaction(
    public.get_or_create_default_portfolio(),
    input_type, input_symbol, input_quantity, input_price, input_amount, input_fee,
    input_original_currency, input_fx_rate_at_transaction, input_occurred_at, input_broker,
    input_underlying_symbol, input_contract_symbol, input_option_kind, input_option_side,
    input_strike_price, input_expiration_date, input_multiplier, input_note, input_idempotency_key
  );
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
declare target_portfolio uuid; normalized_amount numeric(28,8); normalized_price numeric(28,8); normalized_fee numeric(28,8);
begin
  select transaction.portfolio_id into target_portfolio
  from public.portfolio_transactions as transaction
  join public.portfolios as portfolio on portfolio.id = transaction.portfolio_id
  where transaction.id = transaction_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  if input_type in ('transfer_in', 'transfer_out') or exists (
    select 1 from public.portfolio_transactions where id = transaction_id and transfer_id is not null
  ) then
    raise exception 'Paired transfers cannot be edited as standalone transactions' using errcode = '23514';
  end if;
  perform public.assert_portfolio_accepts_transaction(target_portfolio, input_type, false);
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

create or replace function public.delete_portfolio_ledger_transaction(transaction_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_portfolio uuid;
begin
  select transaction.portfolio_id into target_portfolio
  from public.portfolio_transactions as transaction
  join public.portfolios as portfolio on portfolio.id = transaction.portfolio_id
  where transaction.id = transaction_id and portfolio.user_id = (select auth.uid());
  if target_portfolio is null then raise exception 'Transaction not found' using errcode = '42501'; end if;
  if exists (select 1 from public.portfolio_transactions where id = transaction_id and transfer_id is not null) then
    raise exception 'Paired transfers cannot be deleted as standalone transactions' using errcode = '23514';
  end if;
  perform 1 from public.portfolios where id = target_portfolio for update;
  delete from public.portfolio_transactions where id = transaction_id and portfolio_id = target_portfolio;
  perform public.assert_portfolio_ledger_valid(target_portfolio);
end;
$$;

create or replace function public.transfer_portfolio_cash(
  source_portfolio_id uuid, destination_portfolio_id uuid, input_amount_usd numeric,
  input_occurred_at timestamptz, input_note text, input_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare requesting_user uuid := (select auth.uid()); transfer_key uuid := input_idempotency_key; first_id uuid; second_id uuid;
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
    set idempotency_key = excluded.idempotency_key
  returning id into first_id;
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
    set idempotency_key = excluded.idempotency_key
  returning id into second_id;
  return transfer_key;
end;
$$;

revoke all on function public.create_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) from public, anon;
revoke all on function public.transfer_portfolio_cash(uuid,uuid,numeric,timestamptz,text,uuid) from public, anon;
grant execute on function public.create_portfolio_ledger_transaction(uuid,text,text,numeric,numeric,numeric,numeric,text,numeric,timestamptz,text,text,text,text,text,numeric,date,numeric,text,uuid) to authenticated;
grant execute on function public.transfer_portfolio_cash(uuid,uuid,numeric,timestamptz,text,uuid) to authenticated;

-- Option sell targets now resolve the destination portfolio explicitly.
create or replace function public.upsert_portfolio_option_target(
  input_portfolio_id uuid, input_id uuid, input_contract_symbol text, input_side text, input_mode text,
  input_target_value numeric, input_target_premium numeric, input_estimated_fee numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  perform public.assert_portfolio_accepts_transaction(input_portfolio_id, 'buy_to_open', true);
  if input_id is null then
    insert into public.portfolio_option_targets (
      portfolio_id, contract_symbol, side, mode, target_value, target_premium, estimated_fee
    ) values (
      input_portfolio_id, upper(trim(input_contract_symbol)), input_side, input_mode,
      input_target_value, input_target_premium, input_estimated_fee
    )
    on conflict (portfolio_id, contract_symbol) do update set
      side = excluded.side, mode = excluded.mode, target_value = excluded.target_value,
      target_premium = excluded.target_premium, estimated_fee = excluded.estimated_fee,
      enabled = true, triggered_at = null, updated_at = now()
    returning id into result_id;
  else
    update public.portfolio_option_targets set
      side = input_side, mode = input_mode, target_value = input_target_value,
      target_premium = input_target_premium, estimated_fee = input_estimated_fee,
      enabled = true, triggered_at = null, updated_at = now()
    where id = input_id and portfolio_id = input_portfolio_id
    returning id into result_id;
    if result_id is null then raise exception 'Option target not found' using errcode = '42501'; end if;
  end if;
  return result_id;
end;
$$;

create or replace function public.upsert_portfolio_option_target(
  input_id uuid, input_contract_symbol text, input_side text, input_mode text,
  input_target_value numeric, input_target_premium numeric, input_estimated_fee numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.upsert_portfolio_option_target(
    public.get_or_create_default_portfolio(), input_id, input_contract_symbol,
    input_side, input_mode, input_target_value, input_target_premium, input_estimated_fee
  );
end;
$$;

revoke all on function public.upsert_portfolio_option_target(uuid,uuid,text,text,text,numeric,numeric,numeric) from public, anon;
grant execute on function public.upsert_portfolio_option_target(uuid,uuid,text,text,text,numeric,numeric,numeric) to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name) values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', '')) on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  insert into public.watchlists (user_id, name) values (new.id, 'รายการโปรด') on conflict (user_id) do nothing;
  insert into public.portfolios (user_id, name, portfolio_type, is_legacy)
  values (new.id, 'Default / Legacy', 'LEGACY', true)
  on conflict (user_id) where is_legacy do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
