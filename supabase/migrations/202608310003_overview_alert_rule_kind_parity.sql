begin;

-- ===========================================================================
-- The rule writer accepts every kind the rule column permits
-- ===========================================================================
--
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
-- QUEUE: 202608310003
--
-- Evidence: this file replaces a function, and PostgREST reports relations and
-- columns, never function bodies — so nothing about this file's state is
-- observable from outside. What IS observable is the disagreement it fixes:
-- `overview_alert_rules.kind` is a live column and its CHECK admits five values,
-- while `create_overview_alert_rule` — the only supported way to create a rule —
-- admits four. Marked unapplied because it has not been run.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT, AND WHY IT WAS INVISIBLE
-- ---------------------------------------------------------------------------
-- `202608300001` created the column with four kinds and wrote the same four into
-- the function that inserts a row. `202608310001` then widened the column to
-- five, because a hit has to be able to record an `earnings` match:
--
--     check (kind in ('price_above', 'price_below', 'percent_up',
--                     'percent_down', 'earnings'))
--
-- It widened the CHECK on `overview_alert_rules` and the CHECK on
-- `overview_alert_hits`. It did not touch the function, which still refuses:
--
--     if input_kind not in ('price_above', 'price_below',
--                           'percent_up', 'percent_down') then
--       raise exception 'Unknown alert kind' using errcode = '22023';
--
-- So the table can hold an `earnings` rule, the sweep can evaluate one, the
-- cooldown table gives it its own 24-hour period, the hits table can record it —
-- and no reader can create one. `earnings` is one of the five kinds the feature
-- is designed around, and it was reachable by nothing.
--
-- Nothing caught it because NOTHING CALLED THE FUNCTION. The adapter inserted
-- into the table directly, so it was the column's five-value CHECK that applied,
-- not the function's four. That direct insert could not have worked either — it
-- omitted `user_id`, which is `not null` with no default — but the two defects
-- masked each other perfectly: the path that would have hit this one was already
-- broken for a different reason, and neither had a caller.
--
-- ---------------------------------------------------------------------------
-- WHY THE FUNCTION KEEPS ITS OWN LIST AT ALL
-- ---------------------------------------------------------------------------
-- The obvious tidy-up is to delete the check from the function and let the
-- column's CHECK be the single definition. That is rejected, and the reason is
-- the error the caller gets.
--
-- A rejected `input_kind` raises 22023 `invalid_parameter_value` here, which is
-- what the caller asked wrong. Falling through to the column produces 23514
-- `check_violation` naming `overview_alert_rules_kind_check` — a constraint name
-- leaked to a client, describing a table the caller never named. The
-- application maps typed codes onto messages a reader sees, and 23514 from an
-- internal constraint is not one of them.
--
-- The cost of keeping it is exactly the drift this file repairs, so the lists
-- are now pinned against each other by `alerts/service-path.contract.test.ts`,
-- which reads both out of the SQL and fails if they differ again.

-- ---------------------------------------------------------------------------
-- The function, with the fifth kind
-- ---------------------------------------------------------------------------
--
-- `create or replace` with an identical signature, so the existing grants are
-- preserved. They are restated below anyway, matching `202608300001` — a grant
-- that is only implied is a grant nobody can check by reading.
--
-- EVERYTHING ELSE IS UNCHANGED and is reproduced verbatim rather than edited:
-- the advisory lock, the fifty-rule cap counted under it, the owner taken from
-- `auth.uid()`, and the absence of `on conflict` so that a duplicate reaches the
-- caller as 23505. A `create or replace` is a whole-body replacement, so a step
-- dropped here would be a step dropped in production.
create or replace function public.create_overview_alert_rule(
  input_symbol text, input_kind text, input_threshold numeric
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  normalized_symbol text := upper(btrim(input_symbol));
  existing_count integer;
  result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_threshold is null or input_threshold <= 0 then
    raise exception 'Alert threshold must be greater than zero' using errcode = '22023';
  end if;
  /*
    The five values of `overview_alert_rules_kind_check`, and the same five as
    `public.overview_alert_hits.kind`. `earnings` is the one this file adds.

    Its threshold is a WHOLE NUMBER OF DAYS rather than a price or a percentage,
    and it needs no separate branch: the rule is still "one positive number",
    which is the property that let `earnings` share this table in the first
    place. `> 0` above is the whole of the validation either way.
  */
  if input_kind not in (
    'price_above', 'price_below', 'percent_up', 'percent_down', 'earnings'
  ) then
    raise exception 'Unknown alert kind' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':overview-alerts', 0));

  select count(*) into existing_count
  from public.overview_alert_rules where user_id = requesting_user;
  if existing_count >= 50 then
    raise exception 'Alert limit reached' using errcode = '54000';
  end if;

  /*
    No `on conflict`. A duplicate must REACH the caller as 23505 so the action
    can say "มีการแจ้งเตือนแบบนี้อยู่แล้ว"; swallowing it would hand back nothing
    and leave the reader pressing a button that appears to do nothing.
  */
  insert into public.overview_alert_rules (user_id, symbol, kind, threshold)
  values (requesting_user, normalized_symbol, input_kind, input_threshold)
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.create_overview_alert_rule(text, text, numeric) from public, anon;
grant execute on function public.create_overview_alert_rule(text, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- The column comment, which described four kinds
-- ---------------------------------------------------------------------------
--
-- The FOURTH place the kind set is written down, after the two CHECKs and the
-- function. `202608300001` set this comment when there were four kinds and
-- `202608310001` did not revisit it, so the live database currently documents
-- its own `threshold` column as meaning a price or a percentage and nothing
-- else. A day count is neither.
--
-- A comment is not enforcement, which is exactly why it is worth correcting: it
-- is the one of the four that will never fail a test, and it is what somebody
-- reads when they are deciding what the column means.
comment on column public.overview_alert_rules.threshold is
  'Always positive. A price for price_above/price_below, a percentage magnitude for percent_up/percent_down, a whole number of days for earnings - the direction is carried by kind, never by the sign.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Reversible, with one condition that this script cannot check and a person
-- must: narrowing the function back to four kinds does NOT remove the
-- `earnings` rules it allowed to be created. Those rows stay valid — the
-- column's CHECK still admits them — they simply cannot be re-created once
-- deleted. That is the state this file exists to end, so reverting is
-- deliberately a decision rather than a script.
--
--   begin;
--   -- Restore the four-kind body from 202608300001 verbatim, then:
--   comment on column public.overview_alert_rules.threshold is
--     'Always positive. A price for price_above/price_below, a percentage magnitude for percent_up/percent_down - the direction is carried by kind, never by the sign.';
--   commit;
--
-- Nothing else changes. No table is altered, no constraint is touched, no row is
-- read or written by this migration.
