begin;

-- ===========================================================================
-- Expected Move — a collection table, and nothing else
-- ===========================================================================
--
-- NOT YET APPLIED. Reviewed before it is run, like every migration in this
-- programme. Read the reversal section at the bottom first.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- P5 listed options / Expected Move as a context candidate and could not test
-- it. The other three candidates failed a measurement; this one could not be
-- given one, because `__golden__/corpus/` is OHLCV and no provider in this
-- project backfills a historical options chain. There is no way to compute what
-- an expected-move band would have said on 2024-03-15, so there is no way to
-- score it.
--
-- That leaves exactly one route to an answer: write down what the market is
-- pricing today, every day, and come back when there is enough. This table is
-- that, and it is deliberately no more than that.
--
--   * nothing reads it
--   * no feature flag turns anything on
--   * no UI renders it
--   * it is NOT connected to the Market Signal engine
--
-- If it turns out to be worthless, the cost was four numbers a day.
--
-- ---------------------------------------------------------------------------
-- HOW LONG BEFORE IT CAN ANSWER ANYTHING
-- ---------------------------------------------------------------------------
-- This is the part worth knowing before anyone gets impatient with it. Full
-- arithmetic in `docs/market-signal/expected-move-collection.md`; the summary:
--
--   ~12 months   the first suggestive look, at the 5-bar horizon ONLY
--   ~3 years     enough to establish a 2pp effect across all three horizons
--   ~10 years    the 1pp bar the P5 criterion actually used, at 20 bars
--
-- And the sampling arithmetic is not the only constraint: P4a's regime rule
-- requires an effect to hold on both halves of a time split, so a collection
-- window spanning one market state cannot pass regardless of how many rows it
-- holds.
--
-- Nobody should look at this table before the first anniversary of its first
-- row. Doing so produces a number with an interval wider than any effect worth
-- having, and a number like that is how a feature gets built on noise.
--
-- ---------------------------------------------------------------------------
-- WHAT IS STORED, AND WHAT IS DELIBERATELY NOT
-- ---------------------------------------------------------------------------
-- Four quantities and their provenance. Not the chain: a full chain is tens of
-- thousands of rows a day per symbol, and the question being preserved needs the
-- ATM reading rather than the surface. `atm_strike` is kept so that the ATM
-- choice can be audited later, and `days_to_expiry` so a later analysis can
-- filter or normalise rather than trusting the collector's expiry rule.
--
-- No forward outcome column. What price did next is in the candles, and storing
-- it here would create a second copy that can disagree with the first — and this
-- copy is the one an analysis would read.

create table if not exists public.expected_move_observations (
  symbol text not null check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,19}$'),
  /* The trading date this describes, not the timestamp the row was written. */
  as_of date not null,

  spot numeric(20, 6) not null check (spot > 0),
  expiration date not null,
  days_to_expiry integer not null check (days_to_expiry >= 1),
  /* A decimal, not a percentage: 0.284 is 28.4%. */
  atm_iv numeric(10, 6) not null check (atm_iv > 0),
  atm_strike numeric(20, 6) not null check (atm_strike > 0),
  /* spot * iv * sqrt(days/365), in price units, and as a share of spot. */
  implied_move numeric(20, 6) not null check (implied_move > 0),
  implied_move_pct numeric(10, 6) not null check (implied_move_pct > 0),

  /* Which provider served the chain, so a later break in the series is
     attributable rather than mysterious. */
  provider text not null,
  recorded_at timestamptz not null default now(),

  primary key (symbol, as_of)
);

-- The analysis this table exists for reads a date range across all symbols,
-- which the primary key cannot serve with the symbol leading.
create index if not exists expected_move_observations_as_of_idx
  on public.expected_move_observations (as_of);

comment on table public.expected_move_observations is
  'Daily ATM implied volatility and expected move per symbol, collected so that a question P5 could not answer becomes answerable later. Nothing reads this table. See docs/market-signal/expected-move-collection.md — the first useful look is about twelve months after the first row.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client
-- ---------------------------------------------------------------------------
--
-- RLS on, no policy, which means `anon` and `authenticated` read and write
-- nothing. Two reasons rather than one. The obvious: an options-derived series
-- is Elite-entitled material and this table has no entitlement logic in it. The
-- less obvious and more important: nothing in the product reads this table at
-- all, so any client-side access would be access to something with no purpose —
-- and a table nobody reads is exactly the kind of thing whose permissions stop
-- being reviewed.
alter table public.expected_move_observations enable row level security;

revoke all on table public.expected_move_observations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- No retention sweep, on purpose
-- ---------------------------------------------------------------------------
--
-- The whole value of this table is its length. One row per symbol per day, at
-- roughly 85 collectable symbols, is about 21,000 rows a year — a few megabytes
-- a decade. There is nothing here worth deleting, and a retention job would be a
-- mechanism whose only possible effect is to destroy the thing being collected.
--
-- No `cron.schedule` either. The collector is an application script, because
-- fetching an options chain needs a provider key and an HTTP client, neither of
-- which the database has.

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- One table and one index. Nothing that already exists is altered, and no other
-- table is referenced.
--
--   begin;
--   drop table if exists public.expected_move_observations;
--   commit;
--
-- Reversal destroys the collection, and the collection cannot be rebuilt — that
-- is the entire premise of the table. If it is ever dropped, take a copy first
-- unless the intent is specifically to abandon the question.
