begin;

-- ===========================================================================
-- Recording an overview alert hit from a scheduler
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence, and it is weaker than the other two files': this one creates only a
-- function, and PostgREST reports relations and columns, never functions. What
-- the endpoint does publish is an RPC PATH — `/rpc/record_overview_alert_hit_service`
-- is in its OpenAPI definition, which it is not for a function that does not
-- exist. That establishes the function is there; it establishes nothing about
-- the body being the one below. See `docs/operations/migration-state.md`.
--
-- Applied last of the three, after `202608310001` for the table and the column
-- it writes.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND FUNCTION AND NOT AN EDIT
-- ---------------------------------------------------------------------------
-- `public.record_overview_alert_hit` resolves `auth.uid()` and raises 42501 when
-- it is null. That is right for the surface it was written for — a reader's own
-- session, where an id passed in is an id that can be substituted — and it is
-- fatal for a sweep: `/api/cron/alerts` runs with the service role, `auth.uid()`
-- is null there, and every write would raise.
--
-- So there are two functions, which is the shape this schema already uses.
-- `public.trigger_price_alert_service` is the same idea for `price_alerts`:
-- take the row id, derive the owner FROM THE ROW, grant to `service_role` alone.
-- This follows it at every point.
--
-- ---------------------------------------------------------------------------
-- NO OVERLOAD AMBIGUITY, AND WHY NOT
-- ---------------------------------------------------------------------------
-- Postgres overloads on (name, argument types), so a DIFFERENT NAME cannot
-- collide with the existing eight-argument function however similar its
-- parameters are. `record_overview_alert_hit_service` is a distinct name and
-- both functions can carry identical parameter names without ambiguity — which
-- is what lets the two callers use the same argument object.
--
-- The alternative — one function with a nullable `input_user_id` that falls back
-- to `auth.uid()` — was rejected. It would have one grant covering both
-- `authenticated` and `service_role`, and the moment `authenticated` can pass a
-- user id, a signed-in caller can write a hit into somebody else's account.
-- Two functions, two grants, two threat models.
--
-- ---------------------------------------------------------------------------
-- WHAT IS IDENTICAL TO THE AUTHENTICATED VERSION, AND MUST STAY SO
-- ---------------------------------------------------------------------------
-- The advisory lock, the insert and the stamp are the same three steps in the
-- same order in one body. That is not duplication for its own sake: the pair is
-- inseparable in both directions, and a service path that wrote the hit without
-- the stamp would leave the rule permanently out of cooldown and fire it again
-- on every sweep — every fifteen minutes, forever.
create or replace function public.record_overview_alert_hit_service(
  target_rule_id uuid,
  input_symbol text,
  input_kind text,
  input_observed_price numeric,
  input_observed_change_percent numeric,
  input_observed_earnings_days integer,
  input_value_text text,
  input_observed_at timestamptz
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  owned_rule public.overview_alert_rules%rowtype;
  result_id uuid;
begin
  /*
    NO `auth.uid()` ANYWHERE IN THIS BODY. That is the whole difference, and it
    is why the grant below is `service_role` and nothing else: this function
    trusts its caller to have chosen the right rule, so only a caller that
    cannot be a reader may execute it.
  */
  perform pg_advisory_xact_lock(hashtextextended(target_rule_id::text || ':overview-alert-hit', 0));

  /*
    The owner comes from the ROW, exactly as `trigger_price_alert_service` takes
    `owned_alert.user_id` from `price_alerts`. `for update` holds the row for
    the stamp below, so a second sweep of the same rule waits rather than
    reading a `last_fired_at` that is about to change.

    `enabled = true` is checked here as well as in the sweep. The sweep filters
    already; this is the last line of defence, and it is what makes a rule
    switched off between the read and the write not fire.
  */
  select * into owned_rule from public.overview_alert_rules
  where id = target_rule_id and enabled = true
  for update;

  /*
    NULL, not an exception. A scheduler is not a person to show an error to, and
    a rule that was deleted or disabled mid-sweep is an ordinary outcome rather
    than a fault — the same choice `trigger_price_alert_service` makes for the
    same reason. The caller counts a null as "not written" and moves on.
  */
  if not found then return null; end if;

  insert into public.overview_alert_hits (
    rule_id, user_id, symbol, kind,
    observed_price, observed_change_percent, observed_earnings_days,
    value_text, observed_at
  )
  values (
    owned_rule.id, owned_rule.user_id, upper(btrim(input_symbol)), input_kind,
    input_observed_price, input_observed_change_percent, input_observed_earnings_days,
    input_value_text, input_observed_at
  )
  /*
    A retry, a double-invoked cron or a clock adjustment can present the same
    observation twice. The unique index on (rule_id, observed_at) refuses it,
    and `do nothing` turns that refusal into a null return rather than an
    exception that would fail the whole sweep for one duplicate.
  */
  on conflict (rule_id, observed_at) do nothing
  returning id into result_id;

  /*
    Stamped ONLY when a row was actually written, which is the same guard
    `trigger_price_alert_service` puts around its own `last_triggered_at`. A
    stamp written for a hit that was deduplicated away would silence the rule
    for four hours over an event nobody was told about.

    `greatest` so a replayed older observation cannot move the cooldown
    backwards and let the rule fire again sooner.
  */
  if result_id is not null then
    update public.overview_alert_rules
    set last_fired_at = greatest(coalesce(last_fired_at, input_observed_at), input_observed_at),
        updated_at = now()
    where id = owned_rule.id;
  end if;

  return result_id;
end;
$$;

-- `authenticated` is revoked here and NOT granted. A reader reaches the
-- `auth.uid()` version; this one is for the scheduler alone.
revoke all on function public.record_overview_alert_hit_service(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_overview_alert_hit_service(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
) to service_role;

comment on function public.record_overview_alert_hit_service(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
) is
  'Service-role twin of public.record_overview_alert_hit for the scheduled sweep. Derives the owner from the rule row and never reads auth.uid(); granted to service_role only. Both write the hit and stamp the rule in one transaction - see 202608310001 for why the pair is inseparable.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Fully reversible and touches no data. The authenticated function is untouched
-- by this migration in both directions, so dropping this one returns the schema
-- to "readers can record, the scheduler cannot".
--
--   begin;
--   drop function if exists public.record_overview_alert_hit_service(
--     uuid, text, text, numeric, numeric, integer, text, timestamptz);
--   commit;
--
-- Doing so stops the sweep writing anything. It does not corrupt what is already
-- written, and it does not affect the read-time path.
