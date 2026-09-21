-- ============================================================================
-- ROLLBACK: undo 202609200001_unify_alert_rules.sql on production
-- ============================================================================
--
-- WHEN YOU NEED THIS
-- ----------------------------------------------------------------------------
-- You applied `202609200001` during the Phase 2 window and are now reverting
-- the code. Reverting the code ALONE is not enough: production would hold the
-- ten-argument `trigger_price_alert_service` while `background.ts` calls the
-- nine-argument one, which is the same PGRST202 outage in the other direction.
--
-- Run this in the production SQL editor, in the same window as the code revert.
--
-- WHAT IT CANNOT DO
-- ----------------------------------------------------------------------------
-- `202609200001` drops `overview_alert_rules` and `overview_alert_hits`. This
-- file does NOT recreate them, and nothing here can recover rows that were in
-- them. That is why the runbook makes counting those two tables a STOP
-- condition before the migration is applied at all: a drop of a non-empty table
-- is not something a rollback undoes.
--
-- WHERE THE NINE-ARGUMENT BODY CAME FROM
-- ----------------------------------------------------------------------------
-- Lines 159-255 of `supabase/migrations/202608020001_notification_preferences.sql`,
-- verbatim — the definition `202609200001` replaced, plus its revoke/grant pair.
-- It is copied here rather than referenced so that an operator under an
-- incident has one file to paste instead of a file and an extraction command.
--
-- This file is committed for the same reason: a rollback script that exists
-- only on the machine of whoever wrote it is not a rollback script.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Refuse rather than destroy
-- ----------------------------------------------------------------------------
-- Narrowing the CHECK would silently invalidate any earnings alert a reader has
-- created since the migration landed. Deciding which of somebody's alerts to
-- destroy is not a decision a rollback script gets to make quietly, so it stops
-- and says so.
do $guard$
begin
  if exists (select 1 from public.price_alerts where condition = 'earnings') then
    raise exception
      'Some alerts are earnings alerts; resolve them before reverting (select * from public.price_alerts where condition = ''earnings'')';
  end if;
end $guard$;

-- ----------------------------------------------------------------------------
-- 2. Put the condition CHECK back as it was
-- ----------------------------------------------------------------------------
alter table public.price_alerts
  drop constraint if exists price_alerts_earnings_target_check;

alter table public.price_alerts
  drop constraint if exists price_alerts_condition_check;

alter table public.price_alerts
  add constraint price_alerts_condition_check
  check (condition in ('above', 'below', 'percent_change_up', 'percent_change_down'));

-- ----------------------------------------------------------------------------
-- 3. Drop the ten-argument evaluator
-- ----------------------------------------------------------------------------
drop function if exists public.trigger_price_alert_service(
  uuid, numeric, numeric, integer, timestamptz, text, text, text, text, text
);

-- ----------------------------------------------------------------------------
-- 4. Restore the nine-argument evaluator, verbatim from 202608020001
-- ----------------------------------------------------------------------------
create function public.trigger_price_alert_service(
  alert_id uuid,
  observed_price numeric,
  observed_change_percent numeric,
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

  matches_now :=
    (owned_alert.condition = 'above' and observed_price >= owned_alert.target_value)
    or (owned_alert.condition = 'below' and observed_price <= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_up' and observed_change_percent >= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_down' and observed_change_percent <= -owned_alert.target_value);

  update public.price_alerts set
    last_evaluated_at = observed_at,
    last_observed_price = observed_price,
    last_observed_session = observed_session,
    last_observed_source = observed_source,
    last_observed_at = observed_at,
    was_matching = matches_now,
    updated_at = now()
  where id = owned_alert.id;

  if not matches_now or owned_alert.was_matching then return null; end if;

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
  uuid, numeric, numeric, timestamptz, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.trigger_price_alert_service(
  uuid, numeric, numeric, timestamptz, text, text, text, text, text
) to service_role;

commit;

-- ----------------------------------------------------------------------------
-- 5. Verify, after committing
-- ----------------------------------------------------------------------------
-- Exactly one row, and it must show NINE argument types with no `integer`:
--
--   select p.oid::regprocedure
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'trigger_price_alert_service';
--
-- Then call the sweep and read the run it writes:
--
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "Authorization: Bearer $CRON_SECRET" "$HOST/api/cron/alerts"
--
--   select id, started_at, completed_at, status, error
--   from public.alert_evaluation_runs order by started_at desc limit 2;
