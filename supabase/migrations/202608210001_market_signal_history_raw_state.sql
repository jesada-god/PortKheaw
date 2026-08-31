begin;

-- ===========================================================================
-- Market Signal history — the reading BEFORE the hold rule
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence: `market_signal_history.raw_state` resolves, as does the table it
-- alters (`202608180001_market_signal_history.sql`, also applied). NOT covered:
-- `market_signal_history_raw_state_check` and the re-stated `state` check —
-- PostgREST reports relations and columns and nothing else, and production keeps
-- no migration ledger to ask instead. See `docs/operations/migration-state.md`.
--
-- The header this replaces claimed that neither this file nor that table had
-- ever been run. Both were live when it said so.
--
-- This one stays separate rather than folded into that file because a committed
-- migration is a record of what was reviewed, and editing one in place would
-- quietly change what the review was of. Now that both have run, editing either
-- would also make the text disagree with the database it was applied to.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND LABEL COLUMN EXISTS AT ALL
-- ---------------------------------------------------------------------------
-- P8 added a hold rule to the engine: a changed label is published only once
-- the new reading has stood for `MARKET_SIGNAL_PERSISTENCE.minDurationBars`
-- consecutive bars. It exists because `trend_agreement.md` §1 measured the card
-- changing its word 13994 times while the move it describes changed 8603 times
-- — a flip ratio of 1.63 with every flag off, above 1.0 at all 27 definitions
-- of "move" that file tested.
--
-- The hold makes published labels last longer. That is the point, and it is
-- also a trap, because `state` is what the 30-day strip counts a label's age
-- over. An age counted over held labels grows for a reason that has nothing to
-- do with the market, and `docs/signal-handover.md` §6.8 measured why that
-- matters: a SIDEWAYS label 65+ recorded days old describes a market inside its
-- frame 49.2% of the time against 49.9% for one a few days old. Age is not
-- evidence. A number the engine inflated, printed next to a label, is a claim
-- that it is.
--
-- So the raw reading is stored beside the published one, and
-- `summariseHistory` counts the age the card shows over THIS column. Both
-- numbers are published (`currentLabelDays`, `currentRawLabelDays`); only the
-- raw one may reach a reader.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS NULLABLE, AND WHY IT IS NOT BACKFILLED
-- ---------------------------------------------------------------------------
-- Rows written before P8 have no raw reading and one cannot be recovered: it is
-- a property of the engine version that published the row, and replaying
-- today's engine over old bars answers a different question (the same reason
-- the table exists at all — see the base migration). Backfilling `state` into
-- `raw_state` would manufacture a run nobody read.
--
-- `summariseHistory` therefore stops counting rather than guessing: a raw run
-- that reaches a NULL returns `currentRawLabelDays = null`, and the card shows
-- no age at all on those days. That is the honest outcome and it heals on its
-- own as new rows accumulate.

alter table public.market_signal_history
  add column if not exists raw_state text;

comment on column public.market_signal_history.raw_state is
  'The engine reading before the P8 hold rule. NULL for rows written before P8; '
  'never backfilled from state. The age the card shows is counted over this column, '
  'never over state — see docs/signal-handover.md §6.8.';

-- The base migration constrains `state` to the seven labels. The same set
-- applies here, plus NULL for the rows that predate the column.
alter table public.market_signal_history
  drop constraint if exists market_signal_history_raw_state_check;
alter table public.market_signal_history
  add constraint market_signal_history_raw_state_check
  check (raw_state is null or raw_state in (
    'STRONG_BULLISH', 'BULLISH', 'SIDEWAYS', 'SQUEEZE', 'OVEREXTENDED', 'BEARISH', 'STRONG_BEARISH'
  ));

commit;

-- ---------------------------------------------------------------------------
-- REVERSAL
-- ---------------------------------------------------------------------------
-- Dropping the column loses every raw reading recorded since it was applied,
-- and those cannot be recomputed for the reason given above. The card degrades
-- correctly without it (`currentRawLabelDays` becomes null and no age is
-- shown), so the reversal is safe for the page and lossy for the record.
--
--   begin;
--     alter table public.market_signal_history
--       drop constraint if exists market_signal_history_raw_state_check;
--     alter table public.market_signal_history
--       drop column if exists raw_state;
--   commit;
