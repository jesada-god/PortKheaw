begin;

-- ===========================================================================
-- Daily closing snapshot — one row per symbol per trading date
-- ===========================================================================
--
-- NOT YET APPLIED. Written and reviewed before it is run; read the reversal
-- section at the bottom before applying it anywhere.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- The day figure ("วันนี้") on the portfolio card is `quantity × (price −
-- previousClose)`, and it goes null the moment ANY held symbol's quote arrives
-- without a `previousClose`. Outside the regular session that is the normal
-- case, not the exception: several providers stop publishing a previous close
-- once their live feed goes quiet, so the figure blanked out every evening and
-- all weekend — precisely the hours a Thai reader is awake to look at it.
--
-- A live quote is the wrong source for that number anyway once the bell has
-- rung. After the close there is no "today's move" left to compute from a
-- moving price; there is a finished session, and the honest figure is the one
-- that session ended with. This table stores that: the official close of a
-- trading date beside the close of the trading date before it, captured once,
-- after the market has shut, and never revised by a later live tick.
--
-- ---------------------------------------------------------------------------
-- WHAT A ROW MEANS, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------------
-- A row is a claim about a COMPLETED regular session. It is not a cache of a
-- quote, and nothing may write one for a session that has not closed yet — a
-- 14:00 ET "close" is a mid-session price wearing the wrong name, and once it
-- is in this table there is nothing downstream that can tell it apart from a
-- real one. The capture job enforces this by refusing to run before the close;
-- the `date` check below cannot enforce it, which is exactly why it is written
-- down here.
--
-- Gaps are real and must render as gaps. A symbol nobody held on Tuesday has no
-- Tuesday row, and a provider that failed for one symbol leaves that symbol
-- short a day. Neither is corruption, and neither may be interpolated across:
-- the day figure for a session with no row is genuinely unknown, and the card
-- says so in words rather than inventing a number from the nearest row it can
-- find.
create table if not exists public.daily_snapshot (
  /*
    Upper-case, trimmed, and drawn from the same alphabet as every other symbol
    column in this schema, so a row cannot arrive in a form that fails to join
    with the rest of the product. It admits the futures and crypto tickers the
    tracker already covers — GC-F, SI-F, CL-F, BTC-USD.

    The length bound is 32 rather than the 20 used elsewhere, because option
    CONTRACTS are stored here under their OCC symbol and an OCC symbol is the
    underlying plus 15 fixed characters (`GOOGL250117C00150000` is already 20).
    The options detail page shows a day figure per contract and would otherwise
    be the one surface with no source to read outside the session — which is the
    surface that showed a dash the longest.
  */
  symbol text not null check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$'),
  /*
    The exchange-local trading date of the session that CLOSED, in
    America/New_York — never the date the row was written. Those two differ for
    every capture: the job runs at 16:10 ET, which is already the next calendar
    day in Bangkok, and keying on the write date would file a Friday close under
    Saturday and then fail to find it when Friday is asked for.
  */
  date date not null,
  /*
    The official close of `date`, and the official close of the trading date
    immediately before it. Both are stored because the day move is the
    DIFFERENCE, and a reader that had to reconstruct `prev_close` by looking up
    the previous row would silently produce a two-session move whenever the
    previous session's row is one of the gaps described above.

    numeric, not double precision: these feed a money figure, and the ledger
    this product runs on is fixed-point everywhere else.
  */
  close numeric(20, 8) not null check (close > 0),
  /*
    Null when the session before `date` has no verified close — a newly listed
    symbol on its first day, or a gap. A null here means "the move for this
    session cannot be computed", which the card must state as such. It must
    never be coalesced to zero: a zero move is a claim that the price did not
    change, and that is a different sentence.
  */
  prev_close numeric(20, 8) check (prev_close > 0),
  /*
    Which provider the close came from, kept per row rather than per run. A
    backfill from a second provider mixes sources within one date, and when the
    two disagree the only way to find out which rows to re-pull is to know
    which came from where.
  */
  source text not null check (length(trim(source)) between 1 and 64),
  /* When the capture ran. Diagnostic only — never the session the row is about. */
  captured_at timestamptz not null default now(),

  primary key (symbol, date)
);

/*
  "Every symbol captured for this session", which is how the capture job checks
  its own coverage and how a backfill finds the dates it still owes. The
  primary key cannot serve it: its leading column is the symbol.
*/
create index if not exists daily_snapshot_date_idx
  on public.daily_snapshot (date);

comment on table public.daily_snapshot is
  'Official regular-session closes, one row per symbol per trading date, captured after the close and never revised by a live tick. Source for the day figure whenever the market is not open. Service-role only.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client directly
-- ---------------------------------------------------------------------------
--
-- RLS on with NO policy, which in PostgreSQL means `anon` and `authenticated`
-- read and write exactly nothing. Closes are licensed market data: a table a
-- browser session could select from would republish a provider's whole
-- end-of-day file for every symbol the product has ever priced, to anyone with
-- an account.
--
-- Access is service-role only, through the loader the portfolio calculators
-- call, which fetches only the symbols the requesting reader actually holds.
alter table public.daily_snapshot enable row level security;

revoke all on table public.daily_snapshot from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- Deliberately none, and no `cron.schedule` call here.
--
-- The day figure needs two sessions. Everything beyond that is history this
-- table happens to accumulate, and the moment something starts reading it as
-- history, a retention window silently becomes the length of the chart. If a
-- sweep is wanted later it gets its own reviewed migration, once it is clear
-- what else reads this — not bundled into the migration that creates the table,
-- where the first thing the feature ever does unattended would be to delete.

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration adds one table and one index, and alters nothing that already
-- exists. It is reversible with no data loss outside its own table:
--
--   begin;
--   drop table if exists public.daily_snapshot;
--   commit;
--
-- Dropping it loses the captured closes, which CAN be rebuilt from a provider's
-- end-of-day history for any symbol still covered — unlike the signal-history
-- table, this one records what the market did, not what the product said. The
-- rebuild costs provider calls, so take a copy first if the feature might come
-- back.
