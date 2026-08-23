-- Widen `signal_type` to admit CONFLICTED.
--
-- SIDEWAYS was carrying two states that call for opposite reactions: a flat
-- tape where every factor sits near zero, and a chart whose Trend and Momentum
-- are pulling hard against each other and cancelling to a middling total. The
-- second is more dangerous than the first, not less, and both were printing the
-- same grey badge. CONFLICTED is the split.
--
-- This migration is NOT optional alongside that change. The CHECK below is the
-- reason: without it every write of a conflicted signal is rejected by the
-- database, and the history that both percentiles are drawn from would silently
-- stop accumulating for exactly the symbols whose evidence disagrees.
--
-- Rows already written keep their labels. A pre-existing SIDEWAYS row is not
-- reinterpreted here and must not be: it was produced by an engine that could
-- not tell the two apart, and the `config_version` it carries says so. Backfill
-- would be a guess about what a retired model meant.

alter table public.options_signal_history
  drop constraint if exists options_signal_history_signal_type_check;

alter table public.options_signal_history
  add constraint options_signal_history_signal_type_check
  check (signal_type in (
    'PRIME_CALL', 'CALL_WATCH', 'SIDEWAYS', 'CONFLICTED', 'PUT_WATCH', 'PRIME_PUT', 'IV_WARNING'
  ));

comment on constraint options_signal_history_signal_type_check
  on public.options_signal_history is
  'Published label set. CONFLICTED was split out of SIDEWAYS in config version '
  '2026.08.23: rows older than that version can only ever say SIDEWAYS, because '
  'the engine that wrote them had no way to distinguish a quiet tape from '
  'evidence in disagreement.';
