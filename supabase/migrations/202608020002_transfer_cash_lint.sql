begin;

create or replace function public.transfer_portfolio_cash(
  source_portfolio_id uuid,
  destination_portfolio_id uuid,
  input_amount_usd numeric,
  input_occurred_at timestamptz,
  input_note text,
  input_idempotency_key uuid
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  transfer_key uuid := input_idempotency_key;
begin
  if source_portfolio_id = destination_portfolio_id then
    raise exception 'Transfer portfolios must differ' using errcode = '22023';
  end if;
  if input_amount_usd <= 0 then
    raise exception 'Transfer amount must be greater than zero' using errcode = '22023';
  end if;

  perform 1
  from public.portfolios
  where id in (source_portfolio_id, destination_portfolio_id)
    and user_id = requesting_user
    and archived_at is null
  order by id
  for update;

  if (
    select count(*)
    from public.portfolios
    where id in (source_portfolio_id, destination_portfolio_id)
      and user_id = requesting_user
      and archived_at is null
  ) <> 2 then
    raise exception 'Transfer portfolios not found or archived' using errcode = '42501';
  end if;

  insert into public.portfolio_transactions (
    portfolio_id,
    transaction_type,
    amount,
    original_amount,
    original_currency,
    normalized_amount_usd,
    occurred_at,
    occurred_at_time,
    note,
    idempotency_key,
    transfer_id,
    counterparty_portfolio_id
  ) values (
    source_portfolio_id,
    'transfer_out',
    input_amount_usd,
    input_amount_usd,
    'USD',
    input_amount_usd,
    (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at,
    nullif(btrim(input_note), ''),
    input_idempotency_key,
    transfer_key,
    destination_portfolio_id
  )
  on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;

  insert into public.portfolio_transactions (
    portfolio_id,
    transaction_type,
    amount,
    original_amount,
    original_currency,
    normalized_amount_usd,
    occurred_at,
    occurred_at_time,
    note,
    idempotency_key,
    transfer_id,
    counterparty_portfolio_id
  ) values (
    destination_portfolio_id,
    'transfer_in',
    input_amount_usd,
    input_amount_usd,
    'USD',
    input_amount_usd,
    (input_occurred_at at time zone 'Asia/Bangkok')::date,
    input_occurred_at,
    nullif(btrim(input_note), ''),
    input_idempotency_key,
    transfer_key,
    source_portfolio_id
  )
  on conflict (portfolio_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key;

  return transfer_key;
end;
$$;

revoke all on function public.transfer_portfolio_cash(uuid, uuid, numeric, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.transfer_portfolio_cash(uuid, uuid, numeric, timestamptz, text, uuid)
  to authenticated;

commit;
