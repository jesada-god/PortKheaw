begin;

-- ===========================================================================
-- Options Signal history — one row per symbol per finalized-candle date
-- ===========================================================================
--
-- NOT YET APPLIED. Reviewed as a file before it is run, same as the P6 Market
-- Signal history migration it is modelled on. Read the reversal block at the
-- bottom before applying.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS AT ALL
-- ---------------------------------------------------------------------------
-- Two of the engine's readings are meaningless as absolute numbers:
--
--   * an ATM implied volatility of 38% is cheap on one ticker and expensive on
--     another, and
--   * a Put/Call open-interest ratio of 1.51 is routine on one and an outlier
--     on another.
--
-- Both are only interpretable against the SAME SYMBOL's own recent readings, and
-- no entitled provider sells that series. So the product has to accumulate it,
-- one reading per day, which is what this table is. Until roughly sixty rows
-- exist for a symbol the card says how many days are still missing rather than
-- claiming a percentile it cannot compute — a countdown, not a failure.
--
-- The engine ran this on an in-process ring buffer first. That works and is
-- tested, but it resets on every deploy and every cold start, so a sixty-day
-- window could never actually close and the two percentile bases were, in
-- practice, unreachable code. This table is what makes them reachable.
--
-- `inputs` keeps the WHOLE engine input, not a summary, because the point of a
-- history is to answer a question nobody had thought of when the row was
-- written, and a summary can only answer the questions its author already had.
-- Nothing reads it today; the light columns beside it serve the percentiles.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE IS NOT ALLOWED TO BECOME
-- ---------------------------------------------------------------------------
-- Storage only. No back-test, no hit-rate, no "this signal was right 62% of the
-- time" may be computed from these rows and shown to a reader without a separate
-- harness and a separate review: a signal is not a prediction, the product says
-- so on every card, and a win-rate column would quietly make it one.
--
-- `config_version` is on every row for the same reason it is on every history
-- record: change a threshold and yesterday's label recomputes to something else.
-- Rows written under different versions are different statements and anything
-- reading a range MUST NOT silently mix them.

create table if not exists public.options_signal_history (
  /*
    The same symbol shape every other symbol column in this schema uses, so a
    row cannot arrive here in a form that fails to join with the rest of the
    product.
  */
  symbol text not null check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,19}$'),
  /*
    The date of the FINALIZED candle the signal was computed from, not the date
    the row was written. Opening the same symbol six times in an afternoon must
    put ONE reading into the percentile, or a routine day would look like a
    consensus; keying on the write date would file two genuinely different
    readings under one day and lose one of them.
  */
  captured_at date not null,

  /*
    Which revision of the thresholds produced these numbers. Not nullable: a row
    that cannot say what model wrote it is a row nothing may compare.
  */
  config_version text not null,

  signal_type text check (signal_type in (
    'PRIME_CALL', 'CALL_WATCH', 'SIDEWAYS', 'PUT_WATCH', 'PRIME_PUT', 'IV_WARNING'
  )),
  underlying_bias text check (underlying_bias in ('bullish', 'neutral', 'bearish')),
  /* The one published 0-100 direction score. Null on an insufficient-data read. */
  score smallint check (score between 0 and 100),
  confidence smallint check (confidence between 0 and 100),

  /*
    The three series the percentiles are actually drawn from. Kept as their own
    columns rather than dug out of `inputs` on every read: sixty days of jsonb
    per symbol per page view is a cost this feature does not need to pay.

    `double precision` and not `numeric`: these are measurements with a few
    significant figures, they are compared and ranked but never summed into
    money, and a percentile does not care about the last bit.
  */
  iv double precision check (iv is null or (iv > 0 and iv < 100)),
  put_call_oi double precision check (put_call_oi is null or put_call_oi >= 0),
  put_call_volume double precision check (put_call_volume is null or put_call_volume >= 0),

  /* The complete engine input, verbatim. Nothing reads it yet, by design. */
  inputs jsonb not null default '{}'::jsonb,

  recorded_at timestamptz not null default now(),

  /*
    One row per symbol per day, enforced by the schema rather than by the caller.

    This primary key IS the (symbol, captured_at) index the read path needs:
    `where symbol = $1 and captured_at >= $2 order by captured_at` is a range
    scan on its leading column. A separate index on the same two columns in the
    same order would be dead weight on every write, so there is not one.
  */
  primary key (symbol, captured_at)
);

-- Retention sweeps by date across ALL symbols, which the primary key cannot
-- serve because its leading column is the symbol.
create index if not exists options_signal_history_captured_at_idx
  on public.options_signal_history (captured_at);

comment on table public.options_signal_history is
  'What the Options Signal Engine computed, one row per symbol per finalized-candle date. Storage for the IV and Put/Call percentile bases plus a verbatim input archive. Service-role only: no client-facing policy exists and none may be added.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client directly
-- ---------------------------------------------------------------------------
--
-- RLS on with NO policy, which in PostgreSQL means every `anon` and
-- `authenticated` request reads and writes exactly nothing. That is the
-- entitlement boundary: the breakdown behind these numbers is an Elite feature,
-- and a table a Basic session could select from would hand over the entire
-- history of the product's paid output, inputs included.
alter table public.options_signal_history enable row level security;

revoke all on table public.options_signal_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- 400 days, matching the Market Signal history: a little over a year of trading
-- days plus the slack to make "the same week last year" reachable, and far more
-- than the 60 the percentiles need. The number lives in the engine config as
-- `OPTIONS_SIGNAL_CONFIG.history.retentionDays`; this function takes it as an
-- argument rather than hardcoding it, so the config stays the single place it is
-- written down and a caller cannot silently disagree with it.
--
-- Reporting-only by default: `apply => false` counts what is due and deletes
-- nothing, so the first run tells you the size of the delete before you
-- authorise it.
create or replace function public.sweep_options_signal_history(
  retention_days integer,
  apply boolean default false
)
returns table (due bigint, deleted bigint)
language plpgsql
security definer set search_path = ''
as $$
declare
  cutoff date;
  due_count bigint;
  deleted_count bigint := 0;
begin
  if retention_days is null or retention_days < 90 then
    raise exception 'OPTIONS_SIGNAL_HISTORY_RETENTION_TOO_SHORT' using errcode = '22023';
  end if;
  cutoff := (now() at time zone 'utc')::date - retention_days;

  select count(*) into due_count
  from public.options_signal_history where captured_at < cutoff;

  if apply then
    delete from public.options_signal_history where captured_at < cutoff;
    get diagnostics deleted_count = row_count;
  end if;

  return query select due_count, deleted_count;
end;
$$;

revoke all on function public.sweep_options_signal_history(integer, boolean) from public, anon, authenticated;

-- The floor is 90 rather than the Market Signal table's 30: this history feeds a
-- SIXTY-day percentile, so a retention window under 90 days would quietly stop
-- the feature working while looking like a tidy-up. A typo that turns the
-- percentile off should fail loudly instead.

-- No `cron.schedule` call here on purpose, for the same reason the Market Signal
-- migration gives: scheduling a delete in the migration that creates the table
-- means the first thing this feature ever does unattended is remove rows.
-- Schedule it separately once there is enough history for retention to mean
-- anything — which, at 400 days, is not for more than a year.

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration adds one table, one index and one function, and alters nothing
-- that already exists. It is reversible with no data loss outside its own table:
--
--   begin;
--   drop function if exists public.sweep_options_signal_history(integer, boolean);
--   drop table if exists public.options_signal_history;
--   commit;
--
-- Reversal destroys the accumulated IV and Put/Call series, which cannot be
-- rebuilt afterwards: no entitled provider sells historical option chains, so
-- there is nothing to replay. The card degrades honestly — it goes back to
-- saying how many days it still needs — but it starts that count from zero
-- again. Take a copy of the table first if there is any chance it comes back.
