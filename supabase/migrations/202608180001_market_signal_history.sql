begin;

-- ===========================================================================
-- Market Signal history — one row per symbol per day
-- ===========================================================================
--
-- NOT YET APPLIED. This file is written and reviewed before it is run, which is
-- the whole reason it exists as a reviewable artefact rather than as something
-- a deploy did. Read the reversal section at the bottom before applying.
--
-- What this stores is what the card SAID, not what the market did. The market's
-- own history is already in the candles; the thing nobody can reconstruct after
-- the fact is which label was published on which day, because the label is a
-- pure function of the engine at the version it was running. Change a threshold
-- and yesterday's label recomputes to something else — so a history rebuilt by
-- replaying today's engine over old bars is a history of today's engine, not a
-- record of what a reader was shown.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE IS NOT ALLOWED TO BECOME
-- ---------------------------------------------------------------------------
-- P4a measured that a label persists far longer than the thing it describes: a
-- SIDEWAYS label is still SIDEWAYS twenty bars later 72.6% of the time, while
-- price is still inside the frame that label described only 25.7% of the time.
-- The P6 probe (`npm run signal:history`) then asked whether an older label is a
-- more accurate one. Whatever it answered is recorded in the P6 findings doc,
-- and the rule that follows from it is a rule about the UI, not about this
-- table: a strip of thirty days is a DISCLOSURE. Nothing built on this table may
-- rank, score, or visually privilege a label for having stood a long time unless
-- the harness says age predicts accuracy.
--
-- ---------------------------------------------------------------------------
-- ONE ROW PER SYMBOL PER DAY, AND GAPS ARE REAL
-- ---------------------------------------------------------------------------
-- Rows are written when the signal is computed, which happens when somebody
-- opens a page carrying the card. So a symbol nobody looked at on Tuesday has no
-- Tuesday row, and that is not corruption — it is the honest state. A 30-day
-- strip drawn from this table MUST render a gap as a gap. Interpolating across
-- one, or drawing thirty cells regardless, invents a label that was never
-- published on a day nobody asked.
--
-- No trading-calendar column and no attempt to distinguish a market holiday from
-- an unvisited symbol: this table records visits, and pretending otherwise would
-- need a per-instrument calendar it does not have.

create table if not exists public.market_signal_history (
  /*
    The same shape every other symbol column in this schema uses, so a symbol
    cannot arrive here in a form that fails to join with the rest of the product.
    It admits the futures and crypto tickers the card already covers — GC-F,
    SI-F, CL-F, BTC-USD.
  */
  symbol text not null check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,19}$'),
  /*
    The date of the FINALIZED candle the signal was computed from, not the date
    the row was written. Those differ every time somebody opens the card before
    the session's candle closes, and keying on the write date would file two
    genuinely different readings under one day and lose one of them.
  */
  as_of date not null,

  state text not null check (state in (
    'STRONG_BULLISH', 'BULLISH', 'SIDEWAYS', 'SQUEEZE', 'OVEREXTENDED', 'BEARISH', 'STRONG_BEARISH'
  )),
  bias text not null check (bias in ('bullish', 'neutral', 'bearish')),
  /*
    Null when SIGNAL_ZONES was off at write time. A null here is a record that
    the zone layer was not running that day, which is information a later reader
    of the strip needs in order not to read a gap in zones as a gap in the
    market.
  */
  zone text check (zone in ('uptrend', 'downtrend', 'sideways')),
  score smallint check (score between -100 and 100),
  /*
    The engine's internal-consistency figure, stored under the name P4.5 gave it
    rather than under `confidence`. It is NOT a probability and nothing reading
    this table may present it as one.
  */
  evidence_agreement smallint check (evidence_agreement between 0 and 100),
  flags text[] not null default '{}',

  /*
    Which rollout flags were on when the row was written. Without this the table
    is unreadable across a rollout: a SIDEWAYS written with the gate off and a
    SIDEWAYS written with it on are different statements, and a strip that mixes
    them silently shows a "label change" on the day a flag was flipped.
  */
  features jsonb not null default '{}'::jsonb,

  recorded_at timestamptz not null default now(),

  -- The index the brief specifies, and the uniqueness that makes "one row per
  -- symbol per day" true of every row rather than of every row today's code
  -- happened to write. The strip reads `where symbol = $1 order by as_of desc
  -- limit 30`, which this serves directly.
  primary key (symbol, as_of)
);

-- Retention sweeps by date across all symbols, which the primary key cannot
-- serve because its leading column is the symbol.
create index if not exists market_signal_history_as_of_idx
  on public.market_signal_history (as_of);

comment on table public.market_signal_history is
  'What the Market Signal card published, one row per symbol per day. A disclosure record, not an entitlement-free data source: no client-facing policy exists and none may be added — the server applies the technical.outlook entitlement before any of this reaches a reader.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client directly
-- ---------------------------------------------------------------------------
--
-- RLS is enabled and NO policy is created, which in PostgreSQL means every
-- `anon` and `authenticated` request reads and writes exactly nothing. That is
-- deliberate and it is the entitlement boundary: the card behind this data is
-- Elite for equities and Pro for the three contracts, and a table a Basic
-- session could select from would hand over the whole history of the product's
-- paid output.
--
-- Access is service-role only, through `loadEntitledMarketSignal`, which already
-- decides what a given tier may see. Adding a policy here would move that
-- decision into the database and out of the one place it is tested.
alter table public.market_signal_history enable row level security;

revoke all on table public.market_signal_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- 400 days, which is a little over a year of trading days plus the slack to make
-- "the same week last year" reachable. The number lives in `src/config/signal.ts`
-- as well; this function takes it as an argument rather than hardcoding it, so
-- the config file stays the single place it is written down and a caller cannot
-- silently disagree with it.
--
-- Reporting-only by default, in the shape this schema already uses for the trial
-- sweep: `apply => false` counts what is due and deletes nothing, so the first
-- run tells you the size of the delete before you authorise it.
create or replace function public.sweep_market_signal_history(
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
  if retention_days is null or retention_days < 30 then
    raise exception 'MARKET_SIGNAL_HISTORY_RETENTION_TOO_SHORT' using errcode = '22023';
  end if;
  cutoff := (now() at time zone 'utc')::date - retention_days;

  select count(*) into due_count
  from public.market_signal_history where as_of < cutoff;

  if apply then
    delete from public.market_signal_history where as_of < cutoff;
    get diagnostics deleted_count = row_count;
  end if;

  return query select due_count, deleted_count;
end;
$$;

revoke all on function public.sweep_market_signal_history(integer, boolean) from public, anon, authenticated;

-- No `cron.schedule` call here on purpose. Scheduling a delete in the same
-- migration that creates the table it deletes from means the first thing this
-- feature ever does unattended is remove rows. Schedule it in a separate,
-- separately-reviewed migration once there is enough history for retention to
-- mean anything — which, at 400 days, is not for more than a year.

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration adds one table, one index and one function, and alters nothing
-- that already exists. It is reversible with no data loss outside its own table:
--
--   begin;
--   drop function if exists public.sweep_market_signal_history(integer, boolean);
--   drop table if exists public.market_signal_history;
--   commit;
--
-- The only thing that reversal destroys is the published-label history itself,
-- which cannot be reconstructed afterwards — see the note at the top about why
-- replaying the engine does not rebuild it. Take a copy of the table first if
-- there is any chance the feature comes back.
