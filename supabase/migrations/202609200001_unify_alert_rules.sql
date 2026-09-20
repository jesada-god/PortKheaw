begin;

-- ===========================================================================
-- One alert system. `price_alerts` absorbs the fifth kind and the second table
-- goes away.
-- ===========================================================================
--
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-09-20, by PostgREST probe against production.
-- QUEUE: 202608310004, 202609200001, 202609200002
--
-- Evidence, for the state this file changes rather than for the file itself:
-- `price_alerts` resolves `condition`, `cooldown_minutes` and `was_matching`;
-- `overview_alert_rules` and `overview_alert_hits` both resolve and BOTH ARE
-- EMPTY, counted with the service role — which is the fact the merge rests on,
-- and the reason no reader data moves. `/rpc/create_overview_alert_rule`,
-- `/rpc/record_overview_alert_hit`, `/rpc/record_overview_alert_hit_service`,
-- `/rpc/trigger_price_alert` and `/rpc/trigger_price_alert_service` are all in
-- the endpoint's OpenAPI definition, so every function this file drops or
-- replaces is there to drop. NOT covered: any function BODY, the CHECK
-- constraints, or the grants — PostgREST reports relations, columns and RPC
-- paths and nothing else. See `docs/operations/migration-state.md`.
--
-- The four `price_alerts` rows in production are all `condition = 'above'` with
-- the default 60-minute cooldown, so the widened CHECK refuses none of them and
-- the restored cooldown changes no existing alert's behaviour beyond suppressing
-- a repeat inside the hour it already claimed to.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ENDS
-- ---------------------------------------------------------------------------
-- The product carried TWO alert systems over the same four comparisons:
--
--   `price_alerts`          scheduled, notifies, pushes, has a UI, has rows
--   `overview_alert_rules`  scheduled, records a row, no UI, no rows, ever
--
-- `202608300001` argued the split at length and the argument was sound WHEN IT
-- WAS WRITTEN: the second table backed a section evaluated on a page read, wrote
-- nothing, sent nothing, and therefore had nothing to cool down. Enrolling those
-- rules in `price_alerts` would have silently signed every one of them up for a
-- notification sweep, which is the behaviour the feature did not have.
--
-- `202608310001` then gave it a scheduler, a hit table, a cooldown and a
-- `last_fired_at` stamp, and said so in its own header: "That was the right
-- shape for a read-time section and it is the wrong shape for a sweep." At that
-- moment the two systems became the same system, and the separation stopped
-- describing a difference and started being one more place for the five kinds to
-- drift apart — which they immediately did, in `202608310003`.
--
-- What is actually left of the difference is one capability:
--
--     `earnings` — "tell me when this reports within N days"
--
-- That is a condition, not a system. It arrives here as one.
--
-- ---------------------------------------------------------------------------
-- WHY THE MERGE GOES THIS DIRECTION
-- ---------------------------------------------------------------------------
-- `price_alerts` keeps four things `overview_alert_rules` never had, each of
-- which would have to be rebuilt to merge the other way:
--
--   * `notifications` / `queued_notifications` / `push_deliveries` — an Inbox
--     item and a device push, with quiet hours in front of them;
--   * `was_matching` — the CROSSING edge, so a rule that stays true for a week
--     is one notification and not one every fifteen minutes; the hit table's
--     `last_fired_at` cooldown is a weaker version of this same idea;
--   * `last_observed_session` / `_source` — which reading decided it, and the
--     `price_alert_extended_hours` preference that gates pre/post sessions;
--   * `cooldown_minutes` — per rule, set by the reader.
--
-- And it has the rows. `overview_alert_rules` is empty in every environment,
-- because nothing has ever been able to create a rule in it: there is no
-- interface, and `create_overview_alert_rule` has no caller. So this migration
-- moves NO READER DATA. It cannot: there is none to move.
--
-- ---------------------------------------------------------------------------
-- THE ONE OBJECTION `202608300001` RAISED THAT IS STILL LIVE
-- ---------------------------------------------------------------------------
-- "Adding these rows to `price_alerts` would silently enroll every one of them
-- in the notification sweep." True, and now intended: a reader who sets an
-- earnings alert is asking to be told. The answer to "what if somebody wants a
-- silent one" is a column on this table when somebody actually does, not a
-- parallel table maintained on the chance they might.
--
-- ---------------------------------------------------------------------------
-- 202608310003 IS SUPERSEDED, NOT SKIPPED
-- ---------------------------------------------------------------------------
-- That file repairs `create_overview_alert_rule` so it accepts `earnings`. It
-- was never applied, and this migration drops the function it repairs. It is
-- deleted from the repository rather than left as a file that would now fail:
-- applying it after this one would recreate a function against a table that no
-- longer exists. The defect it describes is worth keeping in mind and the reason
-- is recorded in `docs/operations/migration-state.md`.
--
-- `202608310004` is NOT superseded. It repairs the account-deletion purge lists
-- for `user_release_note_state` as well, which has nothing to do with alerts, so
-- it stays — with its two overview entries removed, since the tables they name
-- are dropped here. EITHER ORDER WORKS: applied before this file it deletes from
-- tables that still exist, applied after it does not name them at all.

-- ---------------------------------------------------------------------------
-- 1. The fifth condition
-- ---------------------------------------------------------------------------
--
-- Named `earnings`, matching the vocabulary the dropped table used, because the
-- alternative — inventing a fifth name for the same idea — is how the two
-- systems came to have two names for the same four comparisons.
--
-- The CHECK is replaced rather than edited: a constraint has no ALTER that adds
-- a value, and `202607180009` is applied everywhere, so editing that file's text
-- would produce a history that cannot be reproduced from.
/*
  DROPPED BY WHAT IT SAYS, NOT BY WHAT IT IS CALLED.

  `202607180009` wrote the check inline on the column, so its name was generated
  rather than chosen — `price_alerts_condition_check` by the usual rule, but that
  is an inference about a production database this repository cannot read the
  catalogue of. PostgREST reports relations, columns and RPC paths; it does not
  report constraints.

  A `drop constraint if exists` on a guessed name that is wrong does not fail —
  it does nothing, and then the `add` below creates a SECOND check beside the
  first. Both would apply, the older one would still refuse `earnings`, and the
  symptom would be a save that fails with a constraint violation naming a
  constraint this migration appears to have replaced.

  So this drops every CHECK on the table whose definition mentions the old
  four-value list, whatever it is called, and asserts afterwards that none
  survived.
*/
do $$
declare
  doomed record;
begin
  for doomed in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.price_alerts'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%percent_change_up%'
  loop
    execute format('alter table public.price_alerts drop constraint %I', doomed.conname);
  end loop;

  if exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.price_alerts'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%percent_change_up%'
  ) then
    raise exception 'a condition CHECK survived the drop; earnings would still be refused';
  end if;
end $$;

alter table public.price_alerts
  add constraint price_alerts_condition_check
  check (condition in ('above', 'below', 'percent_change_up', 'percent_change_down', 'earnings'));

/*
  `target_value` means a different thing for this condition, so it gets its own
  bound.

  For the other four it is a price or a percentage and `target_value > 0` — the
  column's own check — says everything. For `earnings` it is a WHOLE NUMBER OF
  DAYS, and "report within 0.5 days" is not a question anybody can be answered:
  the calendar resolves to whole days, so a fractional threshold would compare a
  precise number against a rounded one and behave differently from what it reads
  like.

  365 is the upper bound because an alert that is true all year is not an alert.
  The lower bound is 1 rather than 0: "reports within zero days" is "reports
  today", which `<= 1` already includes on the day itself.
*/
alter table public.price_alerts
  drop constraint if exists price_alerts_earnings_target_check;

alter table public.price_alerts
  add constraint price_alerts_earnings_target_check
  check (
    condition <> 'earnings'
    or (target_value = trunc(target_value) and target_value between 1 and 365)
  );

comment on column public.price_alerts.target_value is
  'A price for above/below, a positive percentage magnitude for the two percent_change conditions, and a whole number of days for earnings. Always positive - the direction is carried by condition, never by the sign.';

-- ---------------------------------------------------------------------------
-- 2. The evaluator learns the reading it did not have
-- ---------------------------------------------------------------------------
--
-- `trigger_price_alert_service` decides every match in SQL, under a row lock, in
-- the same transaction that stamps the row — which is why the new condition is
-- added HERE and not in TypeScript. A caller that decided `earnings` itself and
-- asked this function to record the result would be a second evaluator, and two
-- evaluators over one table is the shape this whole migration exists to remove.
--
-- `observed_earnings_days` is therefore a READING, exactly like
-- `observed_price` and `observed_change_percent`: the caller supplies what the
-- calendar said and this function decides what it means. Null for every symbol
-- with no dated report and for every tick where no rule needed one — the sweep
-- only pays for the calendar when an `earnings` rule actually names a symbol.
--
-- A NEW SIGNATURE, so the old one is dropped first. Postgres overloads on
-- argument types and leaving the nine-argument version in place would let a
-- stale deployment keep calling an evaluator that silently never matches
-- `earnings`.
--
-- IT ALSO READS `cooldown_minutes` AGAIN, which nothing has since
-- `202608020001` — see the comment beside the check, below.
drop function if exists public.trigger_price_alert_service(
  uuid, numeric, numeric, timestamptz, text, text, text, text, text
);

create function public.trigger_price_alert_service(
  alert_id uuid,
  observed_price numeric,
  observed_change_percent numeric,
  observed_earnings_days integer,
  observed_at timestamptz,
  observed_session text,
  observed_source text,
  notification_title text,
  notification_message text,
  input_idempotency_key text
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  owned_alert public.price_alerts%rowtype;
  account_settings public.user_settings%rowtype;
  matches_now boolean;
  result_id uuid;
begin
  if observed_price is null or observed_price <= 0
     or observed_session not in ('regular', 'pre-market', 'after-hours')
     or observed_source is null or char_length(observed_source) not between 1 and 120
  then return null; end if;

  select * into owned_alert from public.price_alerts
  where id = alert_id and enabled = true
  for update;
  if not found then return null; end if;

  select * into account_settings from public.user_settings
  where user_id = owned_alert.user_id;
  if not found or account_settings.price_alerts_enabled is false then
    update public.price_alerts
    set last_evaluated_at = observed_at, updated_at = now()
    where id = owned_alert.id;
    return null;
  end if;
  if observed_session <> 'regular' and account_settings.price_alert_extended_hours is false then
    update public.price_alerts
    set last_evaluated_at = observed_at, updated_at = now()
    where id = owned_alert.id;
    return null;
  end if;

  /*
    The fifth branch.

    A NULL count is not a distant report. The calendar answers for some symbols
    and not others, and reading "we do not know" as "not soon" would mean an
    earnings alert on an uncovered symbol reports itself as checked and unmet
    forever. It is silence instead: `matches_now` is false, `was_matching` is set
    false with it, and the rule fires the moment a date actually appears.

    A NEGATIVE count is a date the calendar has not caught up with, which is the
    same silence for the same reason.
  */
  matches_now :=
    (owned_alert.condition = 'above' and observed_price >= owned_alert.target_value)
    or (owned_alert.condition = 'below' and observed_price <= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_up' and observed_change_percent >= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_down' and observed_change_percent <= -owned_alert.target_value)
    or (
      owned_alert.condition = 'earnings'
      and observed_earnings_days is not null
      and observed_earnings_days >= 0
      and observed_earnings_days <= owned_alert.target_value
    );

  update public.price_alerts set
    last_evaluated_at = observed_at,
    last_observed_price = observed_price,
    last_observed_session = observed_session,
    last_observed_source = observed_source,
    last_observed_at = observed_at,
    was_matching = matches_now,
    updated_at = now()
  where id = owned_alert.id;

  /*
    THE CROSSING EDGE IS WHAT MAKES `earnings` WORKABLE AT ALL.

    "NVDA reports within 7 days" is true for seven days running. `was_matching`
    means the reader is told once, when it becomes true, and not again until the
    date passes and a new one appears — which is what the dropped table needed a
    24-hour cooldown and a `last_fired_at` stamp to approximate. The mechanism
    that was already here is the better one, and it needed nothing added.
  */
  if not matches_now or owned_alert.was_matching then return null; end if;

  /*
    AND `cooldown_minutes` IS HONOURED AGAIN.

    It stopped being read when `202608020001` replaced the cooldown with the
    crossing edge, and the column, the form field on `/alerts` and the
    "Cooldown 60 นาที" line on every alert card went on describing a rule
    nothing enforced. Either the field had to go or the evaluator had to read
    it, and the field turns out to have a job the crossing edge does not do.

    A price sitting ON the threshold crosses it repeatedly. `was_matching` flips
    false on the tick it dips under and true on the tick it comes back, and each
    of those is a genuine new crossing — so an alert at $150 on a stock trading
    at $149.99/$150.01 notifies every fifteen minutes, all day, and every one of
    those notifications is correct. The cooldown is what makes it bearable.

    CHECKED AFTER `was_matching` IS ALREADY WRITTEN, deliberately. A crossing
    suppressed here is not deferred, it is dropped: the row now reads as
    matching, so when the cooldown expires there is no new edge and nothing
    fires. That is the intended reading — the reader was told this level was
    crossed, and being told again about the same level ten minutes later is the
    noise this exists to remove, not a second event.
  */
  if owned_alert.last_triggered_at is not null
     and observed_at < owned_alert.last_triggered_at
                       + make_interval(mins => owned_alert.cooldown_minutes)
  then return null; end if;

  select public.enqueue_account_notification_service(
    owned_alert.user_id,
    'price_alert',
    notification_title,
    notification_message,
    jsonb_build_object(
      'symbol', owned_alert.symbol,
      'condition', owned_alert.condition,
      'targetValue', owned_alert.target_value,
      'triggeredPrice', observed_price,
      'changePercent', observed_change_percent,
      /* Present only for the condition that consulted it. Never a zero. */
      'earningsDays', observed_earnings_days,
      'session', observed_session,
      'source', observed_source,
      'observedAt', observed_at,
      'href', '/stock/' || owned_alert.symbol
    ),
    input_idempotency_key,
    observed_at
  ) into result_id;

  update public.price_alerts
  set last_triggered_at = observed_at, updated_at = now()
  where id = owned_alert.id;
  return result_id;
end;
$$;

revoke all on function public.trigger_price_alert_service(
  uuid, numeric, numeric, integer, timestamptz, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.trigger_price_alert_service(
  uuid, numeric, numeric, integer, timestamptz, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The reader-side evaluator goes, because its caller went
-- ---------------------------------------------------------------------------
--
-- `public.trigger_price_alert` was the authenticated twin, written for a
-- "ตรวจสอบตอนนี้" button that evaluated alerts in the browser's request and
-- wrote the notification itself. That path no longer exists: `/api/alerts/evaluate`
-- returns 202 and defers to the scheduled sweep, and `src/lib/alerts/evaluation.ts`
-- — the only code that ever called this — is deleted in the same change.
--
-- It is dropped rather than left in place. It carries its own copy of the
-- condition list, which this migration has just widened in one place and not the
-- other; a `security definer` function that writes notifications, is granted to
-- every authenticated session, has no caller, and now disagrees with the live
-- evaluator about what an alert means is exactly the drift that produced the
-- second alert system.
drop function if exists public.trigger_price_alert(
  uuid, numeric, numeric, timestamptz, text, text
);

-- ---------------------------------------------------------------------------
-- 4. The second system
-- ---------------------------------------------------------------------------
--
-- Dropped in dependency order: the functions that write the tables, then the
-- child table, then the parent. `overview_alert_hits.rule_id` references
-- `overview_alert_rules`, and `cascade` on the parent would take the child with
-- it — stating both is the same reasoning `202608310004` gives for listing them
-- in order rather than relying on a cascade to do it unremarked.
--
-- NO DATA IS MOVED because there is none: both tables are empty in every
-- environment, for the reason recorded above. If a future environment somehow
-- holds rows, this drops them, and that is the intended outcome — a rule nobody
-- could have created is not a rule anybody is relying on.
drop function if exists public.record_overview_alert_hit_service(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
);
drop function if exists public.record_overview_alert_hit(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
);
drop function if exists public.create_overview_alert_rule(text, text, numeric);

drop table if exists public.overview_alert_hits;
drop table if exists public.overview_alert_rules;

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- The condition widening and the evaluator are reversible. The dropped tables
-- are reversible by re-running `202608300001`, `202608310001` and `202608310002`
-- in that order; their rows are not, and there are none.
--
-- REVERSE THE CODE FIRST. With the ten-argument evaluator gone, the sweep in
-- `src/lib/alerts/background.ts` calls a function that does not exist and every
-- price alert stops firing — which is silent, because a notification that never
-- arrives looks exactly like a threshold that was never crossed.
--
--   begin;
--   -- Any earnings alert must go before the CHECK can narrow again. Loud on
--   -- purpose: deciding which of a reader's alerts to destroy is not a decision
--   -- a rollback script gets to make silently.
--   do $$
--   begin
--     if exists (select 1 from public.price_alerts where condition = 'earnings') then
--       raise exception 'Some alerts are earnings alerts; resolve them before reverting';
--     end if;
--   end $$;
--   alter table public.price_alerts drop constraint if exists price_alerts_earnings_target_check;
--   alter table public.price_alerts drop constraint if exists price_alerts_condition_check;
--   alter table public.price_alerts add constraint price_alerts_condition_check
--     check (condition in ('above', 'below', 'percent_change_up', 'percent_change_down'));
--   drop function if exists public.trigger_price_alert_service(
--     uuid, numeric, numeric, integer, timestamptz, text, text, text, text, text);
--   -- then re-run the nine-argument definition from 202608020001.
--   commit;
