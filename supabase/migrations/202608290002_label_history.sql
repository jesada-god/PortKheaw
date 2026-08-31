begin;

-- ===========================================================================
-- Published label history — one row per scope per key per trading date
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence: `label_history` resolves `scope`, `key`, `date`, `raw_label` and
-- `held_label`. NOT covered: the CHECK constraints and the RLS policies —
-- PostgREST reports relations and columns and nothing else, and production keeps
-- no migration ledger to ask instead. See `docs/operations/migration-state.md`.
--
-- The header this replaces claimed the file had never been run. It said so while
-- the table was live. Read the reversal section at the bottom before changing
-- anything here.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- The hold rule (`src/lib/analytics/persistence-hold.ts`) makes a NEW reading
-- wait `minDurationBars` consecutive evaluations before a card adopts it, so a
-- label that flips for one day is absorbed instead of published. That rule needs
-- to know what the previous evaluations said.
--
-- The Market Signal engine answers that by REPLAYING itself over
-- `candles.slice(0, -k)` — it has candles, so the past is reconstructible and no
-- storage is required. The Market Status card has no candles. It has six quotes
-- taken at one instant, and yesterday's six are gone. So it was passing `[]` as
-- its history on every render, which means `minDurationBars: 2` was configured,
-- documented, tested in isolation, and doing nothing at all in production: every
-- reading published immediately and the status could flip daily.
--
-- This table is that missing memory.
--
-- ---------------------------------------------------------------------------
-- WHAT A ROW MEANS
-- ---------------------------------------------------------------------------
-- A row records WHAT WAS PUBLISHED, and what would have been published without
-- the hold rule. It is not a record of what the market did — that is the
-- candles, and `daily_snapshot` for the closes. Replaying today's engine over
-- old inputs answers a different question, which is the same reason
-- `market_signal_history` exists alongside the candles rather than instead of
-- them.
--
-- Both labels are stored and they are not redundant:
--
--   * `raw_label` is the reading BEFORE the hold. It is what the hold rule reads
--     back — the rule is defined over the raw sequence alone, because a rule
--     that read its own output would need the whole history to answer for today.
--   * `held_label` is what the reader actually saw. Without it there is no
--     record of what was on screen on a given day, which is the only thing here
--     that cannot be recomputed.
--
-- `docs/signal-handover.md` §6.8 forbids label age from feeding any threshold
-- and forbids a card implying an older label is a better one. Any age derived
-- from this table must be counted over `raw_label`. Nothing may rank, score or
-- visually privilege a label for having stood a long time.
create table if not exists public.label_history (
  /*
    WHICH ENGINE PUBLISHED THIS, so one table serves every caller of the shared
    hold rule rather than each growing its own.

    Two exist today: `market-status`, whose key is a constant because the card
    describes one market; and `market-signal`, whose key is a symbol. They are
    kept in one table because they are one KIND of fact — "what did this engine
    publish on this date" — and because the hold rule is shared, so a second
    table would be a second place for the same invariant to drift.

    Constrained rather than free text: an unrecognised scope is a bug in a
    caller, and a typo would silently create a parallel history that reads as
    an empty one.
  */
  scope text not null check (scope in ('market-status', 'market-signal')),
  /*
    What the label is ABOUT, inside its scope.

    A symbol for `market-signal`. For `market-status` it is the single constant
    `US` — the card reads US equities and the three prices around them, and
    naming that rather than using an empty string keeps the column meaningful
    if a second market is ever added.

    Same alphabet as every other symbol column in this schema so a row cannot
    arrive in a form that fails to join, and wide enough for the OCC contract
    symbols `daily_snapshot` already admits.
  */
  key text not null check (key = upper(trim(key)) and key ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$'),
  /*
    The exchange-local trading date the reading is ABOUT, in America/New_York —
    never the date the row was written. Those differ for every evening capture:
    16:10 ET is already the next calendar day in Bangkok, and keying on the write
    date would file a Friday reading under Saturday and then fail to find it when
    Friday is asked for. Same rule, same reason, as `daily_snapshot.date`.
  */
  date date not null,

  /*
    The reading before the hold rule, and the label the reader actually saw.

    Deliberately NOT constrained to a fixed enum. The two engines have different
    vocabularies — UPTREND/WEAK/SIDEWAYS here, seven states there — and a check
    listing both would have to be edited by whoever adds a state to either,
    which is a migration in the path of a UI change. The scope column already
    says which vocabulary applies, and the reading engine validates its own.
  */
  raw_label text not null check (raw_label = upper(trim(raw_label)) and length(raw_label) between 1 and 32),
  held_label text not null check (held_label = upper(trim(held_label)) and length(held_label) between 1 and 32),

  /* When the row was written. Diagnostic only — never the date it is about. */
  captured_at timestamptz not null default now(),

  /*
    One row per scope per key per date. Re-evaluating the same day overwrites
    rather than appending, which is what makes a re-render idempotent: a page
    rendered five times on Tuesday must leave Tuesday's history one entry long,
    or the hold rule would read five consecutive identical labels and adopt a
    new reading the moment somebody refreshed.
  */
  primary key (scope, key, date)
);

/*
  "The last N dates for this scope and key", which is the only read shape the
  hold rule has. The primary key serves it — its leading columns are scope and
  key and the walk is over `date` — so no second index is created. One is added
  here only for the sweep a retention policy would need, and there is no
  retention policy, so there is no index.
*/

comment on table public.label_history is
  'What each engine PUBLISHED, one row per scope per key per trading date, with the pre-hold reading beside it. Feeds the shared hold rule so a label that flips for one day is not published. Service-role only. Age must be counted over raw_label — see docs/signal-handover.md 6.8.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client directly
-- ---------------------------------------------------------------------------
--
-- RLS on with NO policy, which in PostgreSQL means `anon` and `authenticated`
-- read and write exactly nothing. This is the entitlement boundary, not a
-- formality: the Market Signal label is Elite-gated for equities and Pro for the
-- three contracts, and a table a Basic session could select from would hand over
-- the history of the product's paid output for every symbol anybody has viewed.
--
-- Access is service-role only, through the readers that already decide what a
-- given tier may see.
alter table public.label_history enable row level security;

revoke all on table public.label_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- Deliberately none, and no `cron.schedule` call here.
--
-- The hold rule needs `lookbackBars` entries, which is two. Everything beyond
-- that is history this table happens to accumulate, and the moment something
-- starts reading it as history a retention window silently becomes the length of
-- whatever is drawn from it. If a sweep is wanted later it gets its own reviewed
-- migration — not bundled into the migration that creates the table, where the
-- first thing the feature ever does unattended would be to delete.

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration adds one table and alters nothing that already exists. It is
-- reversible with no data loss outside its own table:
--
--   begin;
--   drop table if exists public.label_history;
--   commit;
--
-- Dropping it returns the hold rule to publishing every reading immediately —
-- the behaviour before this change — rather than breaking anything: the readers
-- treat an unavailable table as an empty history, which is the same first-render
-- case they already handle. What is lost is the record of what was published,
-- which cannot be reconstructed afterwards: replaying today's engine over old
-- inputs produces today's engine's answer, not the one a reader was shown.
