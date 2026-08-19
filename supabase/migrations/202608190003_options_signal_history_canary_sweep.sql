begin;

-- ===========================================================================
-- Options Signal history retention — the access canary gets its own window
-- ===========================================================================
--
-- Read the reversal block at the bottom before touching this file.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `202608190001_options_signal_history.sql` reserved the symbol `ZZ-CANARY` for
-- the store's access canary, and the engine config says of it that "the
-- retention sweep clears old ones". It did not. The sweep deletes by date across
-- every symbol alike, so a canary row was kept for the full 400 days.
--
-- The canary writes ONE ROW PER DAY, on the first request each process serves,
-- and nothing ever reads a row older than the one it just wrote — the probe is
-- literally "is the row I just wrote there", and yesterday's answer is not
-- evidence about today. So the table was accumulating more than a year of daily
-- rows under a reserved symbol that no percentile, no card and no query reads.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CHANGES
-- ---------------------------------------------------------------------------
-- The sweep now has two windows and reports them SEPARATELY:
--
--   * `due` / `deleted` — real history, past `retention_days`, canary excluded;
--   * `canary_due` / `canary_deleted` — the reserved symbol, past
--     `canary_retention_days`.
--
-- Separate and not summed, deliberately. A run that clears three hundred canary
-- rows and no history rows must not look like a run that deleted three hundred
-- readings: the first is housekeeping and the second would be the percentile
-- bases being thrown away, and a single number cannot tell an operator which one
-- just happened.
--
-- Seven days rather than one, so a week of canary rows survives as a record of
-- when the store was last reachable — the only question they can answer after
-- the fact. The number lives in the engine config as
-- `OPTIONS_SIGNAL_CONFIG.history.canaryRetentionDays`, and the symbol as
-- `canarySymbol`; both are arguments here rather than literals, so the config
-- stays the single place they are written down.
--
-- Still reporting-only by default. `apply => false` counts both windows and
-- deletes nothing.

-- The return type changes, which `create or replace` cannot do.
drop function if exists public.sweep_options_signal_history(integer, boolean);

create function public.sweep_options_signal_history(
  retention_days integer,
  apply boolean default false,
  canary_symbol text default 'ZZ-CANARY',
  canary_retention_days integer default 7
)
returns table (due bigint, deleted bigint, canary_due bigint, canary_deleted bigint)
language plpgsql
security definer set search_path = ''
as $$
declare
  cutoff date;
  canary_cutoff date;
  due_count bigint;
  deleted_count bigint := 0;
  canary_due_count bigint;
  canary_deleted_count bigint := 0;
begin
  -- Unchanged floor: this history feeds a SIXTY-day percentile, so a window
  -- under 90 days would quietly stop the feature working while looking tidy.
  if retention_days is null or retention_days < 90 then
    raise exception 'OPTIONS_SIGNAL_HISTORY_RETENTION_TOO_SHORT' using errcode = '22023';
  end if;
  -- A zero or negative canary window would delete the row the health check just
  -- wrote, in the same transaction it is about to be read back in.
  if canary_retention_days is null or canary_retention_days < 1 then
    raise exception 'OPTIONS_SIGNAL_HISTORY_CANARY_WINDOW_TOO_SHORT' using errcode = '22023';
  end if;
  -- An empty canary symbol would make the `<>` below match nothing and the `=`
  -- match nothing, silently restoring the bug this migration exists to fix.
  if canary_symbol is null or btrim(canary_symbol) = '' then
    raise exception 'OPTIONS_SIGNAL_HISTORY_CANARY_SYMBOL_REQUIRED' using errcode = '22023';
  end if;

  cutoff := (now() at time zone 'utc')::date - retention_days;
  canary_cutoff := (now() at time zone 'utc')::date - canary_retention_days;

  select count(*) into due_count
  from public.options_signal_history
  where captured_at < cutoff and symbol <> canary_symbol;

  select count(*) into canary_due_count
  from public.options_signal_history
  where symbol = canary_symbol and captured_at < canary_cutoff;

  if apply then
    delete from public.options_signal_history
    where captured_at < cutoff and symbol <> canary_symbol;
    get diagnostics deleted_count = row_count;

    delete from public.options_signal_history
    where symbol = canary_symbol and captured_at < canary_cutoff;
    get diagnostics canary_deleted_count = row_count;
  end if;

  return query select due_count, deleted_count, canary_due_count, canary_deleted_count;
end;
$$;

revoke all on function public.sweep_options_signal_history(integer, boolean, text, integer)
  from public, anon, authenticated;

comment on function public.sweep_options_signal_history(integer, boolean, text, integer) is
  'Retention for options_signal_history. Two windows, reported separately: real readings past retention_days, and access-canary rows past canary_retention_days. apply => false counts and deletes nothing.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration replaces one function and touches no data and no table. The
-- reversal restores the previous single-window function exactly as
-- 202608190001 wrote it:
--
--   begin;
--   drop function if exists public.sweep_options_signal_history(integer, boolean, text, integer);
--   create or replace function public.sweep_options_signal_history(
--     retention_days integer,
--     apply boolean default false
--   )
--   returns table (due bigint, deleted bigint)
--   language plpgsql
--   security definer set search_path = ''
--   as $reverted$
--   declare
--     cutoff date;
--     due_count bigint;
--     deleted_count bigint := 0;
--   begin
--     if retention_days is null or retention_days < 90 then
--       raise exception 'OPTIONS_SIGNAL_HISTORY_RETENTION_TOO_SHORT' using errcode = '22023';
--     end if;
--     cutoff := (now() at time zone 'utc')::date - retention_days;
--     select count(*) into due_count
--     from public.options_signal_history where captured_at < cutoff;
--     if apply then
--       delete from public.options_signal_history where captured_at < cutoff;
--       get diagnostics deleted_count = row_count;
--     end if;
--     return query select due_count, deleted_count;
--   end;
--   $reverted$;
--   revoke all on function public.sweep_options_signal_history(integer, boolean) from public, anon, authenticated;
--   commit;
--
-- Reverting puts canary rows back on the 400-day window, which loses no data but
-- resumes accumulating rows nothing reads. Revert it together with the caller.
