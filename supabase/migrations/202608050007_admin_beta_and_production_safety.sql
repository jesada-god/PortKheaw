begin;

-- Phase 6 — the operator dashboard, the controlled beta, and production safety.
--
-- Additive and forward-only. No table, column, index, policy, grant, trigger or
-- row from Phase 1–5 is dropped, altered or rewritten, and no existing routine is
-- replaced. There is no second auth trigger. Everything below is new.
--
-- The shape of the phase:
--
--   1. `admin_audit_events` — the general operator audit. Phase 5's
--      `support_audit_events` is scoped to a ticket or a refund request by
--      foreign key; a beta stage change belongs to neither, so it needs a table
--      of its own. Both are append-only, and section 9 reads them as one feed so
--      "what did operators do?" has a single answer.
--   2. The controlled beta: one stage row, an invite allowlist, and the caps.
--   3. `beta_funnel_events` — a privacy-safe funnel. Approved keys only, no free
--      text, no payment detail, deduplicated by construction.
--   4. `rate_limit_counters` — a shared fixed-window limiter. It lives in the
--      database because the application runs on serverless instances that share
--      no memory, so an in-process counter would bound nothing.
--   5. The dashboard aggregates, computed in the database over the ledger.
--   6. Readiness, for the public health endpoint.
--
-- One principle runs through all of it, unchanged from Phase 5: a client may
-- describe, and may never decide. Every routine that writes reads its caller from
-- `auth.uid()`, checks the role with `public.is_platform_admin`, and refuses on
-- its own terms. Nothing here is granted directly on a table.

-- ---------------------------------------------------------------------------
-- 1. The general operator audit
-- ---------------------------------------------------------------------------
--
-- Evidence of every operator mutation that is not a ticket or a refund reply.
-- Append-only through the same trigger Phase 5 installed, so a routine with a
-- bug cannot rewrite history any more than a client can.
--
-- `before_summary` and `after_summary` are summaries on purpose. They record the
-- fields that changed and nothing else — never a row dump, which is how a mailbox
-- or a provider identifier ends up in an audit log that outlives the record it
-- describes.
create table if not exists public.admin_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  actor_role text not null default 'admin',
  action text not null,
  target_type text not null,
  -- A *safe* identifier: our own uuid, a stage name, a masked mailbox. Never a
  -- provider customer, subscription, invoice or event id.
  target_ref text,
  before_summary jsonb not null default '{}'::jsonb,
  after_summary jsonb not null default '{}'::jsonb,
  -- Ties an audit row to the request that produced it, for correlation with
  -- server logs. Opaque and generated per request; it identifies no person.
  request_id text,
  created_at timestamptz not null default now(),
  constraint admin_audit_events_role_check check (actor_role in ('admin', 'system')),
  constraint admin_audit_events_action_check check (char_length(action) between 1 and 80),
  constraint admin_audit_events_target_type_check check (char_length(target_type) between 1 and 40),
  constraint admin_audit_events_target_ref_check check (
    target_ref is null or char_length(target_ref) <= 160
  ),
  constraint admin_audit_events_request_id_check check (
    request_id is null or char_length(request_id) <= 64
  )
);

create index if not exists admin_audit_events_created_idx
  on public.admin_audit_events (created_at desc);
create index if not exists admin_audit_events_target_idx
  on public.admin_audit_events (target_type, created_at desc);
create index if not exists admin_audit_events_actor_idx
  on public.admin_audit_events (actor_user_id, created_at desc);

alter table public.admin_audit_events enable row level security;
revoke all on table public.admin_audit_events from anon, authenticated;

-- Its own refusal, rather than Phase 5's `reject_audit_mutation()`.
--
-- That function is support-specific: it reads `old.ticket_id` and
-- `old.refund_request_id` so a *cascade* from a deleted ticket may pass while a
-- direct delete may not. Pointed at this table it would fail with "record has no
-- field ticket_id" — a confusing error where a refusal belongs.
--
-- Here the refusal is unconditional, and it can be, because there is nothing to
-- cascade from: `actor_user_id` carries no foreign key on purpose. An operator
-- audit has to outlive the account that performed the action, or deleting an
-- account would erase the evidence of what it did — and the row holds an opaque
-- id, never a mailbox or a name.
create or replace function public.reject_admin_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
end;
$$;

revoke all on function public.reject_admin_audit_mutation() from public, anon, authenticated;

drop trigger if exists admin_audit_events_append_only on public.admin_audit_events;
create trigger admin_audit_events_append_only
  before update or delete on public.admin_audit_events
  for each row execute function public.reject_admin_audit_mutation();

-- The one writer. Not granted to any client role: it is called from inside the
-- operator routines below, which have already checked the role.
create or replace function public.record_admin_audit_event(
  input_actor_user_id uuid,
  input_action text,
  input_target_type text,
  input_target_ref text,
  input_before jsonb,
  input_after jsonb,
  input_request_id text
)
returns void
language sql
volatile
security definer set search_path = ''
as $$
  insert into public.admin_audit_events (
    actor_user_id, actor_role, action, target_type, target_ref,
    before_summary, after_summary, request_id
  ) values (
    input_actor_user_id,
    'admin',
    left(input_action, 80),
    left(input_target_type, 40),
    left(nullif(btrim(coalesce(input_target_ref, '')), ''), 160),
    coalesce(input_before, '{}'::jsonb),
    coalesce(input_after, '{}'::jsonb),
    left(nullif(btrim(coalesce(input_request_id, '')), ''), 64)
  )
$$;

revoke all on function public.record_admin_audit_event(uuid, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The controlled beta
-- ---------------------------------------------------------------------------
--
-- Four stages, in one row, changed only by an operator.
--
--   closed      nobody new may buy.
--   beta_5_10   a first cohort of 5–10 invited accounts.
--   beta_20_50  a second cohort of 20–50.
--   public      open.
--
-- Two properties this table exists to guarantee:
--
--   * **The stage survives deployment.** The insert below is
--     `on conflict do nothing` and every column is `if not exists`, so replaying
--     this migration — which is what a redeploy of the schema does — cannot move
--     a running program back to its default.
--   * **Nothing reaches `public` on its own.** There is no scheduler, no
--     expiry, no "graduate after N days". The only way the stage changes is an
--     operator calling `admin_set_beta_stage`, which writes an audit row.
--
-- What the stage gates is *starting a new purchase* — checkout visibility and
-- checkout authorization. It deliberately does not gate the product, a renewal,
-- the billing portal, a refund request or support: a reader who already paid must
-- never lose what they bought because a rollout stage changed underneath them.
create table if not exists public.beta_program_state (
  singleton boolean primary key default true,
  stage text not null default 'closed',
  -- The cohort size the operator has chosen inside the stage's band. Null means
  -- "the band's own maximum", and is always null for `closed` and `public`.
  participant_cap integer,
  -- Accounts created before this instant are never gated. It is stamped once,
  -- when the program row is first created, which is what makes introducing the
  -- beta a no-op for every account that already exists — see
  -- `resolve_my_beta_access`.
  enforced_from timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint beta_program_state_singleton_check check (singleton),
  constraint beta_program_state_stage_check check (
    stage in ('closed', 'beta_5_10', 'beta_20_50', 'public')
  ),
  constraint beta_program_state_cap_check check (participant_cap is null or participant_cap >= 0)
);

alter table public.beta_program_state
  add column if not exists stage text not null default 'closed',
  add column if not exists participant_cap integer,
  add column if not exists enforced_from timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid;

-- The program row. `do nothing` is the whole point: a redeploy must not reset a
-- live stage, and must not re-stamp `enforced_from` and thereby start gating
-- accounts that were never meant to be gated.
insert into public.beta_program_state (singleton) values (true)
  on conflict (singleton) do nothing;

alter table public.beta_program_state enable row level security;
revoke all on table public.beta_program_state from anon, authenticated;

-- The invite allowlist.
--
-- Invitations are addressed to a mailbox because that is what an operator has
-- before an account exists. The address is normalized and stored once; it is
-- never returned raw to a browser — `admin_beta_invites` masks it, and the
-- masking is asserted by a test.
create table if not exists public.beta_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  invited_by uuid,
  invited_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  constraint beta_invites_email_check check (
    char_length(email) between 3 and 254 and position('@' in email) > 1
  )
);

create unique index if not exists beta_invites_email_key on public.beta_invites (lower(email));
create index if not exists beta_invites_active_idx
  on public.beta_invites (invited_at desc) where revoked_at is null;

alter table public.beta_invites enable row level security;
revoke all on table public.beta_invites from anon, authenticated;

-- The cap band per stage. Kept in the database as well as in the application's
-- `beta-stages.ts` so the server cannot offer a cohort size the routine would
-- refuse; a test asserts the two agree.
create or replace function public.beta_stage_cap_band(input_stage text)
returns table (min_cap integer, max_cap integer)
language sql
immutable
set search_path = ''
as $$
  select band.min_cap, band.max_cap from (values
    ('closed', 0, 0),
    ('beta_5_10', 5, 10),
    ('beta_20_50', 20, 50),
    -- `public` is uncapped. -1 reads as "no bound" and is never a cohort size.
    ('public', 0, -1)
  ) as band(stage, min_cap, max_cap)
  where band.stage = input_stage
$$;

revoke all on function public.beta_stage_cap_band(text) from public, anon;
grant execute on function public.beta_stage_cap_band(text) to authenticated;

-- The effective cohort size for the stage as configured.
create or replace function public.beta_effective_cap()
returns integer
language sql
stable
security definer set search_path = ''
as $$
  select case
    when state.stage = 'public' then -1
    when state.stage = 'closed' then 0
    else coalesce(state.participant_cap, band.max_cap)
  end
  from public.beta_program_state as state
  cross join lateral public.beta_stage_cap_band(state.stage) as band
  where state.singleton
$$;

revoke all on function public.beta_effective_cap() from public, anon, authenticated;

-- May *this* caller start a new purchase?
--
-- Four ways in, in order of cost:
--
--   1. an operator — always, or the console could lock itself out of the rollout
--      it is running;
--   2. the stage is `public`;
--   3. the account predates `enforced_from`, or already holds a paid
--      subscription. This is what makes the beta non-regressive: introducing it
--      takes nothing away from anybody who was already here;
--   4. the account's mailbox is on the active allowlist.
--
-- `closed` admits only the first of those. A caller with no session is never
-- admitted, and never reaches this function.
create or replace function public.resolve_my_beta_access()
returns table (
  stage text,
  admitted boolean,
  reason text,
  is_admin boolean,
  participant_cap integer,
  active_invites integer,
  database_now timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  state public.beta_program_state%rowtype;
  caller_is_admin boolean := false;
  caller_email text;
  caller_created_at timestamptz;
  cap integer;
  invites integer;
  grandfathered boolean := false;
  invited boolean := false;
  paid boolean := false;
begin
  select * into state from public.beta_program_state where singleton;
  if not found then
    -- No program row means the beta was never configured. Fail *open* here and
    -- only here: the alternative is that a missing row silently closes checkout
    -- for a product that is already selling.
    return query select 'public'::text, true, 'unconfigured'::text, false, -1, 0, statement_timestamp();
    return;
  end if;

  cap := public.beta_effective_cap();
  select count(*)::integer into invites from public.beta_invites where revoked_at is null;

  if requesting_user is null then
    return query select state.stage, false, 'unauthenticated'::text, false, cap, invites, statement_timestamp();
    return;
  end if;

  caller_is_admin := public.is_platform_admin(requesting_user);
  if caller_is_admin then
    return query select state.stage, true, 'admin'::text, true, cap, invites, statement_timestamp();
    return;
  end if;

  if state.stage = 'public' then
    return query select state.stage, true, 'public_stage'::text, false, cap, invites, statement_timestamp();
    return;
  end if;

  select account.email, account.created_at into caller_email, caller_created_at
  from auth.users as account where account.id = requesting_user;

  grandfathered := caller_created_at is not null and caller_created_at < state.enforced_from;

  select exists (
    select 1 from public.user_subscriptions as subscription
    where subscription.user_id = requesting_user
      and subscription.status in ('active', 'past_due', 'trialing')
  ) into paid;

  if state.stage = 'closed' then
    -- Even `closed` keeps existing customers whole. It closes the door to new
    -- purchases; it does not withdraw one already made.
    if grandfathered or paid then
      return query select state.stage, true, case when paid then 'existing_subscriber' else 'pre_existing_account' end,
        false, cap, invites, statement_timestamp();
      return;
    end if;
    return query select state.stage, false, 'closed_stage'::text, false, cap, invites, statement_timestamp();
    return;
  end if;

  if caller_email is not null then
    select exists (
      select 1 from public.beta_invites as invite
      where lower(invite.email) = lower(caller_email) and invite.revoked_at is null
    ) into invited;
  end if;

  if invited then
    return query select state.stage, true, 'invited'::text, false, cap, invites, statement_timestamp();
  elsif paid then
    return query select state.stage, true, 'existing_subscriber'::text, false, cap, invites, statement_timestamp();
  elsif grandfathered then
    return query select state.stage, true, 'pre_existing_account'::text, false, cap, invites, statement_timestamp();
  else
    return query select state.stage, false, 'not_invited'::text, false, cap, invites, statement_timestamp();
  end if;
end;
$$;

revoke all on function public.resolve_my_beta_access() from public, anon;
grant execute on function public.resolve_my_beta_access() to authenticated;

-- Move the stage.
--
-- Explicit, operator-only, audited, and never automatic. The cap is validated
-- against the stage's own band, so `beta_5_10` cannot be configured to admit
-- fifty accounts by sending a larger number.
create or replace function public.admin_set_beta_stage(
  input_stage text,
  input_cap integer,
  input_request_id text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  state public.beta_program_state%rowtype;
  band record;
  resolved_cap integer;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if input_stage not in ('closed', 'beta_5_10', 'beta_20_50', 'public') then
    return 'invalid_stage';
  end if;

  select * into band from public.beta_stage_cap_band(input_stage);

  if input_stage in ('closed', 'public') then
    resolved_cap := null;
  elsif input_cap is null then
    resolved_cap := band.max_cap;
  elsif input_cap < band.min_cap or input_cap > band.max_cap then
    return 'cap_out_of_band';
  else
    resolved_cap := input_cap;
  end if;

  select * into state from public.beta_program_state where singleton for update;
  if not found then return 'not_found'; end if;
  if state.stage = input_stage and state.participant_cap is not distinct from resolved_cap then
    return 'unchanged';
  end if;

  update public.beta_program_state set
    stage = input_stage,
    participant_cap = resolved_cap,
    updated_at = statement_timestamp(),
    updated_by = requesting_user
  where singleton;

  perform public.record_admin_audit_event(
    requesting_user,
    'beta_stage_changed',
    'beta_program',
    input_stage,
    jsonb_build_object('stage', state.stage, 'cap', state.participant_cap),
    jsonb_build_object('stage', input_stage, 'cap', resolved_cap),
    input_request_id
  );

  return 'updated';
end;
$$;

revoke all on function public.admin_set_beta_stage(text, integer, text) from public, anon;
grant execute on function public.admin_set_beta_stage(text, integer, text) to authenticated;

-- Invite a mailbox.
--
-- The cap is enforced *here*, inside the transaction that adds the row, against
-- a locked program row — so two operators inviting at once cannot both pass a
-- check that only one of them should. A client-side count could not do this, and
-- a check after the insert would already have exceeded the cohort.
create or replace function public.admin_add_beta_invite(
  input_email text,
  input_request_id text
)
returns table (invite_id uuid, outcome text, active_invites integer, participant_cap integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  normalized text := lower(btrim(coalesce(input_email, '')));
  cap integer;
  active integer;
  existing public.beta_invites%rowtype;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if char_length(normalized) not between 3 and 254
     or position('@' in normalized) < 2
     or position('.' in split_part(normalized, '@', 2)) < 2 then
    return query select null::uuid, 'invalid_email'::text, 0, 0;
    return;
  end if;

  -- Serializes concurrent invites against the cap.
  perform 1 from public.beta_program_state where singleton for update;

  cap := public.beta_effective_cap();
  select count(*)::integer into active from public.beta_invites where revoked_at is null;

  select * into existing from public.beta_invites where lower(email) = normalized;
  if found and existing.revoked_at is null then
    return query select existing.id, 'already_invited'::text, active, cap;
    return;
  end if;

  -- -1 is "uncapped" (`public`); 0 closes invitations entirely (`closed`).
  if cap >= 0 and active >= cap then
    return query select null::uuid, 'cap_reached'::text, active, cap;
    return;
  end if;

  if found then
    update public.beta_invites set
      revoked_at = null, revoked_by = null,
      invited_by = requesting_user, invited_at = statement_timestamp()
    where id = existing.id
    returning id into new_id;
  else
    insert into public.beta_invites (email, invited_by)
    values (normalized, requesting_user)
    returning id into new_id;
  end if;

  perform public.record_admin_audit_event(
    requesting_user,
    'beta_invite_added',
    'beta_invite',
    new_id::text,
    '{}'::jsonb,
    -- The mailbox is masked before it enters the audit row. An audit log outlives
    -- the record it describes, so it carries the least identifying form that is
    -- still useful to an operator reading it later.
    jsonb_build_object(
      'emailMask',
      left(normalized, 1) || '***@' || split_part(normalized, '@', 2)
    ),
    input_request_id
  );

  return query select new_id, 'invited'::text, active + 1, cap;
end;
$$;

revoke all on function public.admin_add_beta_invite(text, text) from public, anon;
grant execute on function public.admin_add_beta_invite(text, text) to authenticated;

-- Withdraw an invitation. The row is kept and stamped rather than deleted: an
-- invitation that was issued and withdrawn is a fact about the rollout.
create or replace function public.admin_revoke_beta_invite(
  input_invite_id uuid,
  input_request_id text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  invite public.beta_invites%rowtype;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select * into invite from public.beta_invites where id = input_invite_id for update;
  if not found then return 'not_found'; end if;
  if invite.revoked_at is not null then return 'unchanged'; end if;

  update public.beta_invites set
    revoked_at = statement_timestamp(), revoked_by = requesting_user
  where id = invite.id;

  perform public.record_admin_audit_event(
    requesting_user,
    'beta_invite_revoked',
    'beta_invite',
    invite.id::text,
    jsonb_build_object('state', 'active'),
    jsonb_build_object('state', 'revoked'),
    input_request_id
  );

  return 'revoked';
end;
$$;

revoke all on function public.admin_revoke_beta_invite(uuid, text) from public, anon;
grant execute on function public.admin_revoke_beta_invite(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The funnel
-- ---------------------------------------------------------------------------
--
-- Ten approved event keys, and nothing else. The check constraint is the
-- allowlist: an event key the product does not recognise cannot be stored, so
-- this table cannot become a place free-form telemetry accumulates.
--
-- What is deliberately absent: page content, free text, amounts, provider
-- identifiers, invoice identifiers, addresses, user agents, IP addresses. What
-- is here is the account (nullable, and cleared if the account is deleted), the
-- event, which plan and rail it concerned, which feature it concerned, when, and
-- which beta stage was running.
create table if not exists public.beta_funnel_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  event_key text not null,
  plan_key text,
  payment_rail text,
  feature_key text,
  beta_stage text not null,
  -- The Bangkok calendar date the event belongs to. Stored rather than derived so
  -- a daily rollup is an index scan and never a per-row timezone conversion.
  local_date date not null,
  occurred_at timestamptz not null default now(),
  -- What makes an event land once. Composed server-side from the event's own
  -- dedupe scope; the unique index is what actually enforces it.
  dedupe_key text not null,
  constraint beta_funnel_events_key_check check (event_key in (
    'signup_completed',
    'subscription_viewed',
    'checkout_started',
    'checkout_returned',
    'checkout_canceled',
    'payment_succeeded',
    'paywall_blocked',
    'promptpay_renewal_help_viewed',
    'promptpay_renewal_paid',
    'feature_used_before_purchase'
  )),
  constraint beta_funnel_events_stage_check check (
    beta_stage in ('closed', 'beta_5_10', 'beta_20_50', 'public', 'unknown')
  ),
  constraint beta_funnel_events_rail_check check (
    payment_rail is null or payment_rail in ('card', 'promptpay')
  ),
  constraint beta_funnel_events_plan_check check (
    plan_key is null or char_length(plan_key) <= 40
  ),
  constraint beta_funnel_events_feature_check check (
    feature_key is null or char_length(feature_key) <= 60
  ),
  constraint beta_funnel_events_dedupe_check check (char_length(dedupe_key) between 8 and 200)
);

create unique index if not exists beta_funnel_events_dedupe_key
  on public.beta_funnel_events (dedupe_key);
create index if not exists beta_funnel_events_key_time_idx
  on public.beta_funnel_events (event_key, occurred_at desc);
create index if not exists beta_funnel_events_stage_key_idx
  on public.beta_funnel_events (beta_stage, event_key, local_date);
create index if not exists beta_funnel_events_user_idx
  on public.beta_funnel_events (user_id, occurred_at desc);
create index if not exists beta_funnel_events_feature_idx
  on public.beta_funnel_events (feature_key, local_date) where feature_key is not null;

alter table public.beta_funnel_events enable row level security;
revoke all on table public.beta_funnel_events from anon, authenticated;

-- Record one funnel event.
--
-- The caller supplies the key, the plan, the rail, the feature and a dedupe
-- scope. It does *not* supply the account, the timestamp, the calendar date or
-- the beta stage — all four are read here, so a client cannot backdate an event,
-- attribute one to somebody else, or claim it happened in a different stage.
--
-- A duplicate is not an error. It returns `duplicate` and writes nothing, so a
-- double submit, a re-render or a retried action cannot inflate a conversion
-- rate.
create or replace function public.record_beta_funnel_event(
  input_event_key text,
  input_plan_key text,
  input_payment_rail text,
  input_feature_key text,
  input_dedupe_scope text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  observed timestamptz := statement_timestamp();
  bangkok_date date := (observed at time zone 'Asia/Bangkok')::date;
  current_stage text;
  plan text := nullif(btrim(coalesce(input_plan_key, '')), '');
  rail text := nullif(btrim(coalesce(input_payment_rail, '')), '');
  feature text := nullif(btrim(coalesce(input_feature_key, '')), '');
  scope text := nullif(btrim(coalesce(input_dedupe_scope, '')), '');
  composed_key text;
begin
  if input_event_key not in (
    'signup_completed', 'subscription_viewed', 'checkout_started', 'checkout_returned',
    'checkout_canceled', 'payment_succeeded', 'paywall_blocked',
    'promptpay_renewal_help_viewed', 'promptpay_renewal_paid', 'feature_used_before_purchase'
  ) then
    return 'invalid_event';
  end if;

  if rail is not null and rail not in ('card', 'promptpay') then return 'invalid_rail'; end if;
  if plan is not null and char_length(plan) > 40 then return 'invalid_plan'; end if;
  if feature is not null and char_length(feature) > 60 then return 'invalid_feature'; end if;
  if scope is null or char_length(scope) > 120 then return 'invalid_scope'; end if;

  select state.stage into current_stage from public.beta_program_state as state where state.singleton;
  current_stage := coalesce(current_stage, 'unknown');

  -- The account is part of the key, so one reader's event can never collide with
  -- another's. A signed-out event is keyed by scope alone, which is why the
  -- scopes the application composes for anonymous events already carry a random
  -- component.
  composed_key := coalesce(requesting_user::text, 'anon') || ':' || input_event_key || ':' || scope;
  if char_length(composed_key) > 200 then return 'invalid_scope'; end if;

  insert into public.beta_funnel_events (
    user_id, event_key, plan_key, payment_rail, feature_key,
    beta_stage, local_date, occurred_at, dedupe_key
  ) values (
    requesting_user, input_event_key, plan, rail, feature,
    current_stage, bangkok_date, observed, composed_key
  )
  on conflict (dedupe_key) do nothing;

  if not found then return 'duplicate'; end if;
  return 'recorded';
end;
$$;

revoke all on function public.record_beta_funnel_event(text, text, text, text, text) from public;
grant execute on function public.record_beta_funnel_event(text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Rate limiting
-- ---------------------------------------------------------------------------
--
-- A fixed-window counter, shared by every instance because it lives in the
-- database. The application runs on serverless functions that share no memory, so
-- an in-process limiter would bound one instance and nothing else.
--
-- `bucket_key` is a hash the application computes from a scope and either an
-- account id or a proxy-supplied client address. It is a hash on purpose: this
-- table is a rate limiter, not a log of who did what and from where.
create table if not exists public.rate_limit_counters (
  bucket_key text not null,
  window_started_at timestamptz not null,
  hits integer not null default 0,
  expires_at timestamptz not null,
  primary key (bucket_key, window_started_at),
  constraint rate_limit_counters_key_check check (char_length(bucket_key) between 16 and 128),
  constraint rate_limit_counters_hits_check check (hits >= 0)
);

create index if not exists rate_limit_counters_expiry_idx
  on public.rate_limit_counters (expires_at);

alter table public.rate_limit_counters enable row level security;
revoke all on table public.rate_limit_counters from anon, authenticated;

create or replace function public.consume_rate_limit(
  input_bucket_key text,
  input_limit integer,
  input_window_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  observed timestamptz := clock_timestamp();
  window_seconds integer := greatest(1, least(coalesce(input_window_seconds, 60), 86400));
  max_hits integer := greatest(1, least(coalesce(input_limit, 1), 10000));
  window_start timestamptz;
  current_hits integer;
begin
  if input_bucket_key is null or char_length(input_bucket_key) not between 16 and 128 then
    -- A malformed key must not become a way to bypass the limit. It is refused.
    return query select false, 0, window_seconds;
    return;
  end if;

  window_start := to_timestamp(floor(extract(epoch from observed) / window_seconds) * window_seconds);

  insert into public.rate_limit_counters as counter (bucket_key, window_started_at, hits, expires_at)
  values (input_bucket_key, window_start, 1, window_start + make_interval(secs => window_seconds * 2))
  on conflict (bucket_key, window_started_at)
    do update set hits = counter.hits + 1
  returning counter.hits into current_hits;

  -- Opportunistic cleanup, bounded so it can never turn one request into a large
  -- delete. Expired rows are worthless the moment their window closes.
  delete from public.rate_limit_counters
  where ctid in (
    select ctid from public.rate_limit_counters where expires_at < observed limit 50
  );

  if current_hits > max_hits then
    return query select
      false,
      0,
      greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => window_seconds)) - observed))::integer);
    return;
  end if;

  return query select true, max_hits - current_hits, 0;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The dashboard
-- ---------------------------------------------------------------------------
--
-- One round trip for the whole overview. Every number is computed from the
-- ledger — `user_subscriptions` for membership, `billing_invoices` for money,
-- `billing_webhook_retries` for delivery health, `billing_reconciliation_issues`
-- for disagreements. Nothing is estimated and nothing is cached.
--
-- Money is deliberately narrow: recognized revenue is *confirmed money in* minus
-- *confirmed money back*, taken from paid invoices only. An open invoice is not
-- revenue, an approved refund request is not a refund, and neither appears here.
--
-- Every window is a Bangkok calendar window, converted once, so "today" means the
-- operator's today rather than the database's UTC day.
create or replace function public.admin_dashboard_overview(
  input_from_date date,
  input_to_date date
)
returns table (
  basic_members integer,
  pro_members integer,
  elite_members integer,
  trial_members integer,
  promptpay_pending integer,
  past_due_members integer,
  new_members_today integer,
  new_members_7d integer,
  new_members_30d integer,
  revenue_today_minor bigint,
  revenue_month_minor bigint,
  revenue_period_minor bigint,
  refunds_period_minor bigint,
  failed_webhooks integer,
  dead_letter_webhooks integer,
  open_reconciliation_issues integer,
  critical_reconciliation_issues integer,
  open_tickets integer,
  open_refund_requests integer,
  period_from date,
  period_to date,
  database_now timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  observed timestamptz := statement_timestamp();
  today date := (observed at time zone 'Asia/Bangkok')::date;
  from_date date;
  to_date date;
  swap date;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  from_date := coalesce(input_from_date, today - 29);
  to_date := coalesce(input_to_date, today);
  if from_date > to_date then
    -- A reversed range is corrected rather than refused. It is a UI slip, and an
    -- empty dashboard would read as "no revenue" rather than "bad input".
    swap := from_date;
    from_date := to_date;
    to_date := swap;
  end if;

  return query
  with membership as (
    select
      public.resolve_effective_subscription_tier(subscription.user_id, observed) as effective_tier,
      subscription.status,
      subscription.trial_ends_at
    from public.user_subscriptions as subscription
  ),
  signups as (
    select (account.created_at at time zone 'Asia/Bangkok')::date as local_date
    from auth.users as account
  ),
  paid_invoices as (
    select
      invoice.amount_paid_minor,
      invoice.amount_refunded_minor,
      (invoice.paid_at at time zone 'Asia/Bangkok')::date as paid_date
    from public.billing_invoices as invoice
    where invoice.paid_at is not null
      and invoice.status in ('paid', 'refunded', 'partially_refunded', 'disputed')
  )
  select
    (select count(*)::integer from membership where effective_tier = 'basic'),
    (select count(*)::integer from membership where effective_tier = 'pro'),
    (select count(*)::integer from membership where effective_tier = 'elite'),
    (select count(*)::integer from membership
      where status = 'trialing' and trial_ends_at is not null and trial_ends_at > observed),
    (select count(*)::integer from public.billing_pending_payments as pending
      where pending.status = 'awaiting_payment'
        and (pending.due_at is null or pending.due_at > observed)),
    (select count(*)::integer from membership where status = 'past_due'),
    (select count(*)::integer from signups where local_date = today),
    (select count(*)::integer from signups where local_date > today - 7),
    (select count(*)::integer from signups where local_date > today - 30),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date = today),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date >= date_trunc('month', today)::date and paid_date <= today),
    (select coalesce(sum(amount_paid_minor - amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date between from_date and to_date),
    (select coalesce(sum(amount_refunded_minor), 0)::bigint
      from paid_invoices where paid_date between from_date and to_date),
    (select count(*)::integer from public.billing_webhook_retries where status = 'retrying'),
    (select count(*)::integer from public.billing_webhook_retries where status = 'dead_letter'),
    (select count(*)::integer from public.billing_reconciliation_issues where resolved_at is null),
    (select count(*)::integer from public.billing_reconciliation_issues
      where resolved_at is null and severity = 'critical'),
    (select count(*)::integer from public.support_tickets where status in ('open', 'in_progress')),
    (select count(*)::integer from public.refund_requests
      where status in ('pending', 'reviewing', 'approved')),
    from_date,
    to_date,
    observed;
end;
$$;

revoke all on function public.admin_dashboard_overview(date, date) from public, anon;
grant execute on function public.admin_dashboard_overview(date, date) to authenticated;

-- Recent money movements, as one searchable, filterable, pageable list.
--
-- Four kinds in one projection so the console can show "what happened lately"
-- without four queries and four paginations. The mailbox is returned because an
-- operator answering "was I charged twice?" needs to know whose row they are
-- looking at; the application masks it before it renders, and reveals it only on
-- an explicit operator action.
--
-- `provider_ref` is the provider's own identifier and is returned for exactly one
-- purpose: building the server-side deep link into the provider's dashboard. It
-- is never rendered as text — the console shows a masked label — and it never
-- reaches a page a non-operator can open.
create or replace function public.admin_recent_billing_activity(
  input_kind text,
  input_query text,
  input_limit integer,
  input_offset integer
)
returns table (
  activity_kind text,
  occurred_at timestamptz,
  user_id uuid,
  email text,
  plan_key text,
  status text,
  amount_minor bigint,
  currency text,
  payment_rail text,
  provider_ref text,
  total_count bigint
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  kind text := coalesce(nullif(btrim(coalesce(input_kind, '')), ''), 'all');
  needle text := nullif(btrim(coalesce(input_query, '')), '');
  page_size integer := greatest(1, least(coalesce(input_limit, 20), 100));
  page_offset integer := greatest(0, coalesce(input_offset, 0));
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if kind not in ('all', 'payment', 'cancellation', 'refund', 'dispute') then
    return;
  end if;

  return query
  with activity as (
    select
      'payment'::text as activity_kind,
      invoice.paid_at as occurred_at,
      invoice.user_id,
      invoice.plan_key,
      invoice.status,
      invoice.amount_paid_minor::bigint as amount_minor,
      invoice.currency,
      case when subscription.billing_collection_method = 'send_invoice'
        then 'promptpay' else 'card' end as payment_rail,
      invoice.invoice_id as provider_ref
    from public.billing_invoices as invoice
    left join public.user_subscriptions as subscription on subscription.user_id = invoice.user_id
    where invoice.paid_at is not null

    union all

    select
      'cancellation'::text,
      coalesce(subscription.updated_at, subscription.current_period_end),
      subscription.user_id,
      subscription.billing_plan_key,
      subscription.status,
      0::bigint,
      'thb'::text,
      case when subscription.billing_collection_method = 'send_invoice'
        then 'promptpay' else 'card' end,
      null::text
    from public.user_subscriptions as subscription
    where subscription.cancel_at_period_end
       or subscription.status in ('canceled', 'expired')

    union all

    select
      case when event.kind = 'refund' then 'refund'::text else 'dispute'::text end,
      event.occurred_at,
      event.user_id,
      null::text,
      coalesce(event.dispute_outcome, event.outcome),
      event.amount_minor::bigint,
      event.currency,
      null::text,
      event.invoice_id
    from public.billing_refund_events as event
  )
  select
    activity.activity_kind,
    activity.occurred_at,
    activity.user_id,
    account.email::text,
    activity.plan_key,
    activity.status,
    activity.amount_minor,
    activity.currency,
    activity.payment_rail,
    activity.provider_ref,
    count(*) over ()
  from activity
  left join auth.users as account on account.id = activity.user_id
  where activity.occurred_at is not null
    and (kind = 'all' or activity.activity_kind = kind)
    and (
      needle is null
      or account.email ilike '%' || needle || '%'
      or activity.user_id::text = needle
      or activity.plan_key ilike '%' || needle || '%'
    )
  /*
   * The tiebreakers are not decoration. Several rows genuinely share a
   * timestamp — an invoice paid and its subscription updated in the same
   * statement — and `order by occurred_at desc` alone leaves their relative
   * order undefined, so page 2 can repeat a row page 1 already showed and drop
   * one entirely. Ordering on a total key makes paging stable.
   */
  order by
    activity.occurred_at desc,
    activity.activity_kind,
    activity.user_id,
    coalesce(activity.provider_ref, '')
  limit page_size offset page_offset;
end;
$$;

revoke all on function public.admin_recent_billing_activity(text, text, integer, integer)
  from public, anon;
grant execute on function public.admin_recent_billing_activity(text, text, integer, integer)
  to authenticated;

-- The beta report.
--
-- Aggregates by stage, and never a per-account list: the question a rollout asks
-- is "did this cohort convert?", not "what did this person do?". The per-account
-- drill-down an operator sometimes needs already exists — it is the billing
-- console's account search, which is separately gated and separately audited.
create or replace function public.admin_beta_report()
returns table (
  stage text,
  invited integer,
  signed_up integer,
  paid integer,
  signup_completed integer,
  subscription_viewed integer,
  checkout_started integer,
  checkout_returned integer,
  checkout_canceled integer,
  payment_succeeded integer,
  paywall_blocked integer,
  promptpay_help_viewed integer,
  promptpay_renewal_paid integer,
  features_used_before_purchase integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  with stages as (
    select unnest(array['closed', 'beta_5_10', 'beta_20_50', 'public', 'unknown']) as stage
  ),
  -- Invitations belong to the program rather than to a stage: an invite issued in
  -- one cohort is still live in the next. It is therefore attributed to the stage
  -- that is running now, which is the only stage it can currently admit anyone to.
  current_stage as (
    select coalesce((select state.stage from public.beta_program_state as state where state.singleton), 'unknown') as stage
  ),
  invites as (
    select
      (count(*) filter (where invite.revoked_at is null))::integer as invited,
      (count(*) filter (where invite.revoked_at is null and account.id is not null))::integer as signed_up,
      (count(*) filter (
        where invite.revoked_at is null
          and subscription.status in ('active', 'past_due')
      ))::integer as paid
    from public.beta_invites as invite
    left join auth.users as account on lower(account.email::text) = lower(invite.email)
    left join public.user_subscriptions as subscription on subscription.user_id = account.id
  ),
  -- Distinct accounts, not raw events: a funnel measures people moving, and a
  -- reader who opened the plans page four times is one person considering a
  -- purchase. Anonymous events count once each, since there is no account to
  -- collapse them onto.
  counted as (
    select
      event.beta_stage as stage,
      event.event_key,
      count(distinct coalesce(event.user_id::text, event.dedupe_key))::integer as accounts
    from public.beta_funnel_events as event
    group by event.beta_stage, event.event_key
  )
  select
    stages.stage,
    case when stages.stage = current_stage.stage then invites.invited else 0 end,
    case when stages.stage = current_stage.stage then invites.signed_up else 0 end,
    case when stages.stage = current_stage.stage then invites.paid else 0 end,
    coalesce(max(counted.accounts) filter (where counted.event_key = 'signup_completed'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'subscription_viewed'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'checkout_started'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'checkout_returned'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'checkout_canceled'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'payment_succeeded'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'paywall_blocked'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'promptpay_renewal_help_viewed'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'promptpay_renewal_paid'), 0),
    coalesce(max(counted.accounts) filter (where counted.event_key = 'feature_used_before_purchase'), 0)
  from stages
  cross join current_stage
  cross join invites
  left join counted on counted.stage = stages.stage
  group by
    stages.stage, current_stage.stage,
    invites.invited, invites.signed_up, invites.paid
  order by array_position(
    array['closed', 'beta_5_10', 'beta_20_50', 'public', 'unknown'], stages.stage
  );
end;
$$;

revoke all on function public.admin_beta_report() from public, anon;
grant execute on function public.admin_beta_report() to authenticated;

-- Which paywalls block people, and which features they reach for before paying.
-- Feature keys are product configuration, never personal data.
create or replace function public.admin_beta_feature_report(input_limit integer)
returns table (
  event_key text,
  feature_key text,
  accounts integer,
  occurrences integer,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  page_size integer := greatest(1, least(coalesce(input_limit, 20), 100));
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    event.event_key,
    event.feature_key,
    count(distinct coalesce(event.user_id::text, event.dedupe_key))::integer,
    count(*)::integer,
    max(event.occurred_at)
  from public.beta_funnel_events as event
  where event.feature_key is not null
    and event.event_key in ('paywall_blocked', 'feature_used_before_purchase')
  group by event.event_key, event.feature_key
  order by count(distinct coalesce(event.user_id::text, event.dedupe_key)) desc, max(event.occurred_at) desc
  limit page_size;
end;
$$;

revoke all on function public.admin_beta_feature_report(integer) from public, anon;
grant execute on function public.admin_beta_feature_report(integer) to authenticated;

-- The invite list, for the console. The mailbox is returned in full because an
-- operator managing invitations needs to know which address they invited; the
-- application masks it on render and reveals it only on an explicit action.
create or replace function public.admin_beta_invites(
  input_query text,
  input_limit integer,
  input_offset integer
)
returns table (
  invite_id uuid,
  email text,
  invited_at timestamptz,
  revoked_at timestamptz,
  has_account boolean,
  has_paid boolean,
  total_count bigint
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  needle text := nullif(btrim(coalesce(input_query, '')), '');
  page_size integer := greatest(1, least(coalesce(input_limit, 25), 100));
  page_offset integer := greatest(0, coalesce(input_offset, 0));
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    invite.id,
    invite.email,
    invite.invited_at,
    invite.revoked_at,
    account.id is not null,
    coalesce(subscription.status in ('active', 'past_due'), false),
    count(*) over ()
  from public.beta_invites as invite
  left join auth.users as account on lower(account.email::text) = lower(invite.email)
  left join public.user_subscriptions as subscription on subscription.user_id = account.id
  where needle is null or invite.email ilike '%' || needle || '%'
  order by invite.revoked_at nulls first, invite.invited_at desc
  limit page_size offset page_offset;
end;
$$;

revoke all on function public.admin_beta_invites(text, integer, integer) from public, anon;
grant execute on function public.admin_beta_invites(text, integer, integer) to authenticated;

-- The program state, for the console.
create or replace function public.admin_beta_program_state()
returns table (
  stage text,
  participant_cap integer,
  effective_cap integer,
  active_invites integer,
  enforced_from timestamptz,
  updated_at timestamptz,
  database_now timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    state.stage,
    state.participant_cap,
    public.beta_effective_cap(),
    (select count(*)::integer from public.beta_invites where revoked_at is null),
    state.enforced_from,
    state.updated_at,
    statement_timestamp()
  from public.beta_program_state as state
  where state.singleton;
end;
$$;

revoke all on function public.admin_beta_program_state() from public, anon;
grant execute on function public.admin_beta_program_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. One audit feed
-- ---------------------------------------------------------------------------
--
-- Phase 5's ticket and refund audit and this phase's general audit, read as one
-- ordered list. Neither table is granted to anybody; this is the only path to
-- either, and it checks the role in the database.
--
-- Only operator rows from `support_audit_events` are included. A reader replying
-- to their own ticket is not an administrative action and does not belong in an
-- operator audit.
create or replace function public.admin_audit_feed(
  input_limit integer,
  input_offset integer
)
returns table (
  source text,
  action text,
  target_type text,
  target_ref text,
  actor_user_id uuid,
  before_summary jsonb,
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
  page_size integer := greatest(1, least(coalesce(input_limit, 25), 100));
  page_offset integer := greatest(0, coalesce(input_offset, 0));
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  with feed as (
    select
      'admin'::text as source,
      event.action,
      event.target_type,
      event.target_ref,
      event.actor_user_id,
      event.before_summary,
      event.after_summary,
      event.request_id,
      event.created_at
    from public.admin_audit_events as event

    union all

    select
      'support'::text,
      event.action,
      case when event.ticket_id is not null then 'support_ticket' else 'refund_request' end,
      coalesce(event.ticket_id, event.refund_request_id)::text,
      event.actor_user_id,
      case when event.from_status is null then '{}'::jsonb
        else jsonb_build_object('status', event.from_status) end,
      case when event.to_status is null then '{}'::jsonb
        else jsonb_build_object('status', event.to_status) end,
      null::text,
      event.created_at
    from public.support_audit_events as event
    where event.actor_role = 'admin'
  )
  select
    feed.source, feed.action, feed.target_type, feed.target_ref, feed.actor_user_id,
    feed.before_summary, feed.after_summary, feed.request_id, feed.created_at,
    count(*) over ()
  from feed
  order by feed.created_at desc
  limit page_size offset page_offset;
end;
$$;

revoke all on function public.admin_audit_feed(integer, integer) from public, anon;
grant execute on function public.admin_audit_feed(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Readiness
-- ---------------------------------------------------------------------------
--
-- What the public health endpoint is allowed to know.
--
-- Coarse on purpose. It returns whether the database answered and how fresh the
-- scheduler is as a *word*, never a timestamp, a row count, an error message, a
-- provider name or a configuration value. An unauthenticated caller learns that
-- the service is healthy or that it is not, and nothing an attacker could use.
create or replace function public.platform_readiness()
returns table (database_ready boolean, scheduler_status text)
language sql
stable
security definer set search_path = ''
as $$
  select
    true,
    coalesce((
      select case
        when run.completed_at > now() - interval '45 minutes' then 'ok'
        when run.completed_at > now() - interval '3 hours' then 'lagging'
        else 'stale'
      end
      from public.alert_evaluation_runs as run
      where run.completed_at is not null
      order by run.completed_at desc
      limit 1
    ), 'unknown')
$$;

revoke all on function public.platform_readiness() from public;
grant execute on function public.platform_readiness() to anon, authenticated;

commit;
