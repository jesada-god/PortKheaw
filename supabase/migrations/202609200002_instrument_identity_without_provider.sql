-- ============================================================================
-- AN INSTRUMENT IS A SYMBOL, NOT A SYMBOL-AND-A-VENDOR.
-- ============================================================================
--
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-09-20, by PostgREST probe against both projects.
--
-- Evidence: the constraint this replaces is
-- `market_instruments_provider_symbol_key unique (provider, provider_symbol)`,
-- and its effect IS observable from outside — a project where it still holds
-- can carry the same `provider_symbol` twice, once per provider. Counted today:
--
--   vhhjdzcjczqmvjrgrrom (dev)   total 12,636   alpha-vantage 0       nasdaq-trader 12,636
--   jjmenqktnabmajpqxzhr (prod)  total 12,506   alpha-vantage 12,506  nasdaq-trader 0
--
-- Both are single-provider today, so with the old key in force neither can be
-- holding a duplicate symbol. Dev WAS forked — 25,272 rows, every symbol under
-- both providers, on 2026-09-05 — and was collapsed by hand. Production has not
-- been re-synced since `scripts/sync-instruments.ts` started recording the
-- provider that actually answered, which is the only reason it has not forked
-- too. It will on its first fallback run until this file is applied.
--
-- No QUEUE line: the unapplied set is contested while an uncommitted migration
-- sits beside this one, and a queue that disagrees with its neighbours is worse
-- than no queue. `docs/operations/migration-state.md` carries the list.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- `market_instruments` was keyed on `(provider, provider_symbol)`, and every
-- join, filter and deactivation in `finalize_market_instrument_sync` was scoped
-- `where i.provider = run_record.provider`. The table was therefore partitioned
-- by vendor: each provider owned a private copy of the instrument universe.
--
-- That was invisible while the sync always wrote the same provider string. It
-- stopped being invisible the moment the sync started recording the provider
-- that ACTUALLY served a run (see `scripts/sync-instruments.ts`): the first
-- fallback run inserted a second full universe under 'nasdaq-trader' beside the
-- 12,636 rows still sitting under 'alpha-vantage', because the deactivation
-- step only ever looked at rows of its own provider. 25,272 rows, every symbol
-- twice, and a search that returns AAPL twice.
--
-- The identity was wrong, not the attribution. AAPL is one instrument. Which
-- vendor's directory it was last read from is a FACT ABOUT THE READING, not
-- part of what the row is — the same way `last_synced_at` is.
--
-- So: `provider_symbol` alone is the key, `provider` becomes an ordinary column
-- that records who served the row most recently, and the sync replaces the
-- whole universe on every run regardless of which vendor answered.
--
-- ============================================================================
-- WHAT THIS DOES TO EXISTING ROWS
-- ============================================================================
-- Duplicates created by the fork are collapsed, keeping the MOST RECENTLY
-- SYNCED row for each `provider_symbol`. That is the honest choice: the newest
-- row came from the run whose provider string is trustworthy, while the older
-- one carries the constant that was written regardless of who answered.
--
-- Nothing references `market_instruments.id`, checked across every migration,
-- so collapsing rows cannot orphan anything.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Collapse the fork. Newest reading per symbol wins; ties break on id so the
--    result is deterministic rather than whatever the planner returned first.
-- ----------------------------------------------------------------------------
delete from public.market_instruments i
using (
  select id,
    row_number() over (
      partition by provider_symbol
      order by last_synced_at desc, updated_at desc, id asc
    ) as rank
  from public.market_instruments
) ranked
where i.id = ranked.id and ranked.rank > 1;

-- ----------------------------------------------------------------------------
-- 2. The key is the symbol. The vendor is an attribute of the last reading.
-- ----------------------------------------------------------------------------
alter table public.market_instruments
  drop constraint if exists market_instruments_provider_symbol_key;

alter table public.market_instruments
  add constraint market_instruments_provider_symbol_key unique (provider_symbol);

comment on column public.market_instruments.provider is
  'The vendor whose directory last served this row. An attribute of the reading, '
  'not part of the row identity — see 202609200002.';

-- ----------------------------------------------------------------------------
-- 3. Finalize, rewritten so a run owns the whole universe.
--
--    Every `i.provider = run_record.provider` is gone. The upsert now also
--    WRITES `provider`, so a symbol re-read from the fallback stops claiming
--    the primary the moment it is re-synced — which is the whole point.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_market_instrument_sync(input_run_id uuid, input_failed_count integer default 0)
returns table (inserted integer, updated integer, skipped integer, failed integer)
language plpgsql security definer set search_path = '' as $$
declare run_record record; inserted_value integer; changed_value integer; missing_value integer; skipped_value integer;
begin
  select * into run_record from public.market_instrument_sync_runs where id = input_run_id for update;
  if run_record.id is null then raise exception 'Instrument sync run not found'; end if;
  if run_record.status = 'completed' then
    return query select run_record.inserted_count, run_record.updated_count, run_record.skipped_count, run_record.failed_count;
    return;
  end if;

  select count(*)::integer into inserted_value
  from public.market_instrument_sync_stage s
  left join public.market_instruments i on i.provider_symbol = s.provider_symbol
  where s.run_id = input_run_id and i.id is null;

  /*
    A row counts as changed when a FACT about the instrument changed, or when
    the vendor that served it changed. The second is new: re-reading AAPL from
    the fallback leaves every column identical except `provider`, and reporting
    that as "skipped" would hide the one thing that did move.
  */
  select count(*)::integer into changed_value
  from public.market_instrument_sync_stage s
  join public.market_instruments i on i.provider_symbol = s.provider_symbol
  where s.run_id = input_run_id and
    row(i.symbol, i.name, i.exchange, i.asset_type, i.currency, i.country, i.status, i.ipo_date, i.delisting_date, i.provider)
    is distinct from row(s.symbol, s.name, s.exchange, s.asset_type, s.currency, s.country, s.status, s.ipo_date, s.delisting_date, run_record.provider);

  select count(*)::integer into missing_value from public.market_instruments i
  where i.status = 'active'
    and not exists (select 1 from public.market_instrument_sync_stage s where s.run_id = input_run_id and s.provider_symbol = i.provider_symbol);

  select greatest(count(*)::integer - inserted_value - changed_value, 0) into skipped_value
  from public.market_instrument_sync_stage where run_id = input_run_id;

  insert into public.market_instruments
    (symbol, name, exchange, asset_type, currency, country, status, ipo_date, delisting_date, provider, provider_symbol, last_synced_at)
  select s.symbol, s.name, s.exchange, s.asset_type, s.currency, s.country, s.status,
    s.ipo_date, s.delisting_date, run_record.provider, s.provider_symbol, now()
  from public.market_instrument_sync_stage s where s.run_id = input_run_id
  on conflict (provider_symbol) do update set
    symbol = excluded.symbol, name = excluded.name, exchange = excluded.exchange,
    asset_type = excluded.asset_type, currency = excluded.currency, country = excluded.country,
    status = excluded.status, ipo_date = excluded.ipo_date, delisting_date = excluded.delisting_date,
    provider = excluded.provider,
    last_synced_at = excluded.last_synced_at,
    updated_at = case when row(public.market_instruments.symbol, public.market_instruments.name, public.market_instruments.exchange,
      public.market_instruments.asset_type, public.market_instruments.currency, public.market_instruments.country,
      public.market_instruments.status, public.market_instruments.ipo_date, public.market_instruments.delisting_date,
      public.market_instruments.provider)
      is distinct from row(excluded.symbol, excluded.name, excluded.exchange, excluded.asset_type, excluded.currency,
      excluded.country, excluded.status, excluded.ipo_date, excluded.delisting_date, excluded.provider)
      then now() else public.market_instruments.updated_at end;

  /*
    Everything the run did not carry is delisted, whoever last served it. This
    is the line the fork hid behind: scoped to one provider, a symbol dropped by
    the vendor that is now answering stayed 'active' forever under the vendor
    that used to.
  */
  update public.market_instruments i set status = 'delisted', delisting_date = coalesce(i.delisting_date, current_date),
    last_synced_at = now(), updated_at = now()
  where i.status = 'active'
    and not exists (select 1 from public.market_instrument_sync_stage s where s.run_id = input_run_id and s.provider_symbol = i.provider_symbol);

  update public.market_instrument_sync_runs set status = 'completed', inserted_count = inserted_value,
    updated_count = changed_value + missing_value, skipped_count = skipped_value,
    failed_count = greatest(input_failed_count, 0), completed_at = now()
  where id = input_run_id;

  delete from public.market_instrument_sync_stage where run_id = input_run_id;
  return query select inserted_value, changed_value + missing_value, skipped_value, greatest(input_failed_count, 0);
end;
$$;

revoke all on function public.finalize_market_instrument_sync(uuid, integer) from public, anon, authenticated;

commit;
