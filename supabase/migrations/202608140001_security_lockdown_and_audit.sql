begin;

-- Phase 3 — incident response: the security lockdown, and the security slice of
-- the operator audit.
--
-- Additive and forward-only. No table, column, index, policy, grant, row or
-- trigger from an earlier phase is dropped, and no earlier routine is replaced.
-- Everything below is either a new column with a default, a new routine, or a
-- new trigger on an existing table.
--
-- The shape of the phase:
--
--   1. **The lockdown switch**, stored beside the maintenance switch in
--      `app_runtime_settings` but deliberately *not the same flag*.
--   2. **One posture read** for middleware, so adding a second runtime switch
--      does not add a second round trip to every request.
--   3. **The toggle**, operator-only, audited in the same transaction.
--   4. **Enforcement in the database**, as triggers on the two tables where
--      privilege actually lives — so a caller who never touches the application
--      is refused by the same rule the application applies.
--   5. **The security slice of `admin_audit_events`** — a writer with an
--      allowlisted vocabulary, and an operator-only reader.
--
-- Why lockdown is separate from maintenance, and not a second maintenance level:
--
--   Maintenance answers "is the product serving readers". It is planned, it is
--   announced, it redirects everybody to a notice, and an operator keeps the
--   whole product because they are the one who has to check it before switching
--   it back on.
--
--   Lockdown answers "do we currently trust our own privileged paths". It is
--   unplanned, it is silent to ordinary readers, and it binds *operators hardest
--   of all* — because the incident it exists for is a compromised operator
--   session, and a switch that an attacker in that session can simply turn off is
--   not a control. Reading them as two levels of one dial would mean an incident
--   is always also an outage, which is exactly the pressure that makes people
--   turn the dial back down early.
--
-- One principle, unchanged since Phase 5: a client may describe, and may never
-- decide. Every routine here reads its caller from `auth.uid()`, checks the role
-- with `public.is_platform_admin`, and refuses on its own terms.

-- ---------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------
--
-- Columns on the existing singleton rather than a table of its own, for the same
-- reason maintenance lives there: there is one running program, and a second
-- table that can hold two rows is a table that will eventually disagree with
-- itself about whether the product is locked down.
--
-- `security_lockdown_reason` is the operator's own note to the next operator. It
-- is never shown to a reader — an ordinary reader is not told the product is in
-- lockdown at all, because "we are having a security incident" is an invitation
-- and the reader-visible symptom is a refused privileged write they were never
-- going to make.
alter table public.app_runtime_settings
  add column if not exists security_lockdown_enabled boolean not null default false,
  add column if not exists security_lockdown_reason text,
  add column if not exists security_lockdown_started_at timestamptz,
  add column if not exists security_lockdown_started_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_runtime_settings'::regclass
      and conname = 'app_runtime_settings_lockdown_reason_check'
  ) then
    alter table public.app_runtime_settings
      add constraint app_runtime_settings_lockdown_reason_check check (
        security_lockdown_reason is null or char_length(security_lockdown_reason) <= 300
      );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reading the posture
-- ---------------------------------------------------------------------------
--
-- The one read middleware makes, answering both switches and the caller's role
-- in a single round trip.
--
-- A second RPC beside `resolve_maintenance_state` would have doubled the latency
-- of the gate that runs on every request — at exactly the moment the product is
-- fragile, which is when both switches are most likely to be on. The older
-- routine is left in place untouched: a deployment is not atomic, and for a few
-- minutes an old build queries a migrated database and a new build queries an
-- unmigrated one. Both have something to call.
--
-- `is_admin` comes back in the same row because the gate needs it and asking
-- twice would cost a second trip. It is false for `anon` by construction.
create or replace function public.resolve_runtime_posture()
returns table (
  maintenance_enabled boolean,
  security_lockdown_enabled boolean,
  is_admin boolean,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    settings.maintenance_enabled,
    settings.security_lockdown_enabled,
    coalesce(public.is_platform_admin((select auth.uid())), false),
    now()
  from public.app_runtime_settings as settings
  where settings.singleton
$$;

revoke all on function public.resolve_runtime_posture() from public;
grant execute on function public.resolve_runtime_posture() to anon, authenticated;

/*
 * The predicate the enforcement below is written in terms of.
 *
 * `stable` and `security definer`, so a trigger on a table no client may read
 * can still consult a settings row no client may read either.
 *
 * A missing row reads as "not locked down". That is the availability-preserving
 * answer and it is safe here for a specific reason: this predicate never grants
 * anything. Every caller has already passed its own authorization check, and
 * this only ever takes privileges away. An unreadable switch declining to take
 * them away leaves the product exactly as protected as it was before lockdown
 * existed.
 */
create or replace function public.is_security_locked_down()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select settings.security_lockdown_enabled
     from public.app_runtime_settings as settings
     where settings.singleton),
    false
  )
$$;

revoke all on function public.is_security_locked_down() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Moving the switch
-- ---------------------------------------------------------------------------
--
-- Operator-only, audited in the same transaction as the flag, and — the part
-- that matters — deliberately **not** blocked by the lockdown it controls. A
-- control that cannot be released while it is engaged is a lockout, and the
-- operator ending an incident is the one caller who must always get through.
--
-- What stands between a stolen operator session and this routine is not the
-- lockdown, it is the second factor: the application gates every call to this on
-- `aal2`, which a stolen cookie does not carry and cannot be upgraded to.
create or replace function public.admin_set_security_lockdown(
  input_enabled boolean,
  input_reason text,
  input_request_id text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  settings public.app_runtime_settings%rowtype;
  next_reason text;
  turning_on boolean;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if input_enabled is null then
    return 'invalid_state';
  end if;

  next_reason := left(nullif(btrim(coalesce(input_reason, '')), ''), 300);

  select * into settings from public.app_runtime_settings where singleton for update;
  if not found then return 'not_found'; end if;

  if settings.security_lockdown_enabled = input_enabled
    and settings.security_lockdown_reason is not distinct from
        (case when input_enabled then next_reason else null end)
  then
    return 'unchanged';
  end if;

  turning_on := input_enabled and not settings.security_lockdown_enabled;

  update public.app_runtime_settings set
    security_lockdown_enabled = input_enabled,
    security_lockdown_reason = case when input_enabled then next_reason else null end,
    -- Stamped on the transition in and cleared on the way out, never re-stamped
    -- by an operator editing the reason mid-incident: the duration of an incident
    -- must not reset because somebody clarified the note.
    security_lockdown_started_at = case
      when not input_enabled then null
      when turning_on then statement_timestamp()
      else settings.security_lockdown_started_at
    end,
    security_lockdown_started_by = case
      when not input_enabled then null
      when turning_on then requesting_user
      else settings.security_lockdown_started_by
    end,
    updated_at = statement_timestamp(),
    updated_by = requesting_user
  where singleton;

  perform public.record_admin_audit_event(
    requesting_user,
    case when input_enabled then 'security.lockdown.enabled' else 'security.lockdown.disabled' end,
    'runtime_settings',
    'security_lockdown',
    jsonb_build_object('lockdown_enabled', settings.security_lockdown_enabled),
    -- The reason is the operator's own note, written for the next operator, and
    -- is kept as evidence of why the product was locked. Nothing else about the
    -- row is: no session, no address, no token.
    jsonb_build_object('lockdown_enabled', input_enabled, 'reason', next_reason),
    input_request_id
  );

  return case when input_enabled then 'enabled' else 'disabled' end;
end;
$$;

revoke all on function public.admin_set_security_lockdown(boolean, text, text) from public, anon;
grant execute on function public.admin_set_security_lockdown(boolean, text, text) to authenticated;

-- The operator's own view of both switches. Separate from
-- `resolve_runtime_posture` because "who locked this and when" is an operator
-- fact, not one every request needs or every caller may have.
create or replace function public.admin_security_posture()
returns table (
  maintenance_enabled boolean,
  security_lockdown_enabled boolean,
  security_lockdown_reason text,
  security_lockdown_started_at timestamptz,
  security_lockdown_started_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  database_now timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null or not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select
      settings.maintenance_enabled,
      settings.security_lockdown_enabled,
      settings.security_lockdown_reason,
      settings.security_lockdown_started_at,
      settings.security_lockdown_started_by,
      settings.updated_at,
      settings.updated_by,
      now()
    from public.app_runtime_settings as settings
    where settings.singleton;
end;
$$;

revoke all on function public.admin_security_posture() from public, anon;
grant execute on function public.admin_security_posture() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Enforcement, in the database
-- ---------------------------------------------------------------------------
--
-- The application refuses privileged mutations while the switch is on, at the
-- gate every operator mutation already opens with. This is the layer that holds
-- when the application is not the caller.
--
-- It is written as **triggers on the tables where privilege lives**, rather than
-- as a check pasted into each routine, and that choice is the security property:
-- a check inside `admin_set_beta_stage` protects `admin_set_beta_stage`, while a
-- trigger on `user_roles` protects every path to `user_roles` — including a
-- routine written next month by somebody who never read this file, and including
-- a `service_role` connection from a script.
--
-- Two tables, and only two, because the criterion is narrow: a table is here if a
-- write to it *grants privilege*. That is deliberately not the same as "a table
-- an operator writes".
--
--   `user_roles`               who is an operator.
--   `admin_access_previews`    what an operator's session may currently open.
--
-- Deliberately absent, and each for a reason worth stating:
--
--   `user_subscriptions`       a lockdown must never stop a paid renewal landing.
--                              Blocking the billing webhook would turn a security
--                              incident into silent revenue loss and a wave of
--                              accounts dropping to Basic, which is a worse
--                              outcome than the override this would have caught.
--                              The privileged *override* path is an operator
--                              mutation and is refused at the application gate.
--   `admin_audit_events`       already append-only by its own trigger. Freezing
--                              it during an incident would stop the record of
--                              the incident.
--   `app_runtime_settings`     the switch itself. See the note on the toggle.

create or replace function public.enforce_security_lockdown_on_roles()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if not public.is_security_locked_down() then
    return coalesce(new, old);
  end if;

  /*
   * Scoped to writes that move privilege, not to every write.
   *
   * A fresh signup inserts `role = 'user'` through `handle_new_user`, and a
   * lockdown that refused that would take account creation down as a side effect
   * of an unrelated control — a blast radius nobody asked this switch for. What
   * is refused is the set that actually matters during an incident: granting
   * `admin`, revoking it, or removing the row that records it.
   */
  if tg_op = 'DELETE' then
    if old.role = 'admin' then
      raise exception 'SECURITY_LOCKDOWN' using errcode = '42501';
    end if;
    return old;
  end if;

  if new.role = 'admin' or (tg_op = 'UPDATE' and old.role is distinct from new.role) then
    raise exception 'SECURITY_LOCKDOWN' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_security_lockdown_on_roles() from public, anon, authenticated;

drop trigger if exists user_roles_security_lockdown on public.user_roles;
create trigger user_roles_security_lockdown
  before insert or update or delete on public.user_roles
  for each row execute function public.enforce_security_lockdown_on_roles();

-- The access preview is an operator convenience with no reader-facing path at
-- all, so it is refused wholesale rather than scoped. Nothing legitimate writes
-- it during an incident.
create or replace function public.enforce_security_lockdown_on_previews()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if public.is_security_locked_down() then
    raise exception 'SECURITY_LOCKDOWN' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.enforce_security_lockdown_on_previews() from public, anon, authenticated;

drop trigger if exists admin_access_previews_security_lockdown on public.admin_access_previews;
create trigger admin_access_previews_security_lockdown
  before insert or update or delete on public.admin_access_previews
  for each row execute function public.enforce_security_lockdown_on_previews();

-- ---------------------------------------------------------------------------
-- 5. The security slice of the operator audit
-- ---------------------------------------------------------------------------
--
-- `admin_audit_events` is reused rather than joined by a second table. It is
-- already append-only by trigger, already revoked from every client role, and
-- already the answer to "what happened here?" — and a second audit table would
-- be a second, disagreeing answer, which during an incident is worse than none.
--
-- What is new is that some of these events are recorded about callers who are
-- **not** operators: a Basic account that just posted to an operator action is
-- exactly the event worth keeping. So this writer is reachable by any signed-in
-- caller, and every part of it is built on the assumption that the caller is
-- hostile.
--
--   * **The actor is never taken from the caller.** It is `auth.uid()`.
--   * **The vocabulary is closed.** An event key outside the allowlist below is
--     refused, so the log cannot be filled with attacker-chosen strings.
--   * **The detail is a fixed, typed shape**, assembled here from three scalars.
--     There is no free-text field and no caller-supplied object, which is what
--     stops a password, a token or a full request payload from ever reaching an
--     audit row through this door.
--   * **`actor_role` is `'system'`.** These rows are observations, and recording
--     a non-operator's denied attempt as an *operator* action would corrupt the
--     one feed an incident is read from.
create or replace function public.security_event_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    -- An operator opened the console with a valid identity and a second factor.
    'admin.access.granted',
    -- Someone who is not an operator reached an operator surface.
    'admin.authorization.denied',
    -- An operator reached an operator surface without a second factor.
    'admin.assurance.denied',
    -- A privileged action the console classes as destructive completed.
    'admin.destructive.performed',
    -- Repeated refusals from the shared limiter for one identity.
    'security.rate_limit.repeated',
    -- Abnormally many requests from one identity inside one window.
    'security.request.spike',
    -- Abnormally many socket connections from one identity.
    'security.websocket.spike',
    -- A privileged override of what an account may open.
    'security.subscription.override'
  ]::text[]
$$;

revoke all on function public.security_event_keys() from public;
grant execute on function public.security_event_keys() to authenticated;

create or replace function public.record_security_event(
  input_event_key text,
  input_target_ref text,
  input_observed_count integer,
  input_outcome text,
  input_request_id text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  -- Read from the session, never from an argument. A caller cannot record an
  -- event as somebody else, which is the whole reason this is callable at all.
  requesting_user uuid := (select auth.uid());
  clean_outcome text;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_event_key is null or not (input_event_key = any(public.security_event_keys())) then
    return 'invalid_event';
  end if;

  -- A short, closed vocabulary for the second axis too. Anything else is stored
  -- as `unknown` rather than refused: losing the row would be worse than losing
  -- one word of it, and the row is the evidence.
  clean_outcome := case
    when input_outcome in ('allowed', 'denied', 'throttled', 'observed') then input_outcome
    else 'unknown'
  end;

  insert into public.admin_audit_events (
    actor_user_id, actor_role, action, target_type, target_ref,
    before_summary, after_summary, request_id
  ) values (
    requesting_user,
    -- An observation, not an operator action. See the note above.
    'system',
    left(input_event_key, 80),
    'security',
    -- A *safe* reference: a route, a scope, a class. The application passes a
    -- path or a limiter scope here, never an address, a mailbox or a token.
    left(nullif(btrim(coalesce(input_target_ref, '')), ''), 160),
    '{}'::jsonb,
    jsonb_build_object(
      'outcome', clean_outcome,
      'observedCount', greatest(0, least(coalesce(input_observed_count, 0), 1000000))
    ),
    left(nullif(btrim(coalesce(input_request_id, '')), ''), 64)
  );

  return 'recorded';
end;
$$;

revoke all on function public.record_security_event(text, text, integer, text, text) from public, anon;
grant execute on function public.record_security_event(text, text, integer, text, text) to authenticated;

-- The console's security feed. Operator-only, like every other reader of this
-- table: `admin_audit_events` grants nothing to `anon` or `authenticated`, so
-- this routine and its siblings are the only way any row of it is ever read.
create or replace function public.admin_security_audit(
  input_limit integer,
  input_offset integer
)
returns table (
  id bigint,
  action text,
  actor_user_id uuid,
  actor_role text,
  target_type text,
  target_ref text,
  after_summary jsonb,
  request_id text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null or not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select
      events.id, events.action, events.actor_user_id, events.actor_role,
      events.target_type, events.target_ref, events.after_summary,
      events.request_id, events.created_at, count(*) over ()
    from public.admin_audit_events as events
    where events.target_type = 'security'
       or events.target_type = 'runtime_settings'
       or events.action like 'security.%'
       or events.action like 'admin.a%'
    order by events.created_at desc, events.id desc
    limit greatest(1, least(coalesce(input_limit, 25), 100))
    offset greatest(0, coalesce(input_offset, 0));
end;
$$;

revoke all on function public.admin_security_audit(integer, integer) from public, anon;
grant execute on function public.admin_security_audit(integer, integer) to authenticated;

-- The index the security feed reads through. `admin_audit_events_created_idx`
-- already orders the whole table; this one keeps the filtered slice from
-- scanning every operator action ever recorded to find the security ones.
create index if not exists admin_audit_events_security_idx
  on public.admin_audit_events (target_type, created_at desc, id desc)
  where target_type in ('security', 'runtime_settings');

commit;
