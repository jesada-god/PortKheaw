begin;

-- ===========================================================================
-- Trial-ledger retention, key-version safety, and deletion recovery
-- ===========================================================================
--
-- `202608060002` gave the spent trial a record that outlives the account. It
-- left three things unfinished, and each one is a promise the product had already
-- made without a mechanism behind it:
--
--   1. **Retention.** The privacy page says the claim is kept three years. There
--      was no deadline on any row and nothing that ever deleted one, so "three
--      years" was a sentence rather than a behaviour.
--   2. **Key rotation.** The digest carries a version, but a claim stamped with a
--      version this deployment holds no key for could not be recognised — and a
--      claim that cannot be recognised is a second free week. Rotating the key
--      was therefore unsafe, which is another way of saying it could not be done.
--   3. **A stuck deletion.** The pipeline is resumable by design and nothing could
--      *see* that it needed resuming: an account whose data is purged but whose
--      auth user survives looks, from every query we had, like an account.
--
-- Everything added here is either read-only or granted to `service_role` alone.
-- No browser can read the retention flag, set a legal hold, run the purge, label
-- a claim, or see that any of it exists.
--
-- Deliberately absent, still: an email address, a provider subject, a card, an IP,
-- a name — and, new here, any identity digest in an audit row. The sweep's record
-- is counts and a run id. A log that named the rows it deleted would rebuild, in
-- the audit table, exactly the list the ledger was designed not to be.

-- ---------------------------------------------------------------------------
-- 1. A deadline on every claim
-- ---------------------------------------------------------------------------
--
-- `retain_until` is stamped once, when the claim is created, and never
-- recomputed. That is the whole reason it is a column rather than an expression
-- evaluated by the sweep: a purge that computed `first_claimed_at + <today's
-- policy>` would let a future edit to the policy reach back and shorten a promise
-- already made to somebody who has left. Stored, the policy governs new claims
-- and cannot rewrite old ones.
--
-- `legal_hold_until` outranks it in the one direction that is safe — it keeps a
-- row that would otherwise go. It cannot cause a deletion, only prevent one.
alter table public.trial_identity_claims
  add column if not exists claim_origin text not null default 'user',
  add column if not exists retain_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists legal_hold_set_at timestamptz,
  add column if not exists legal_hold_set_by uuid;

-- Deliberately no free-text column beside the hold. The reason a claim is under
-- dispute belongs in the support ticket that raised it; written here it would be
-- operator prose about one identifiable person, stored in the one table built to
-- hold nothing about anybody.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trial_identity_claims_origin_check'
  ) then
    alter table public.trial_identity_claims
      add constraint trial_identity_claims_origin_check
      check (claim_origin in ('user', 'backfill', 'production_qa'));
  end if;
end;
$$;

-- The retention policy, in one place on the SQL side. `immutable` because it is
-- pure arithmetic over its argument — which is what lets it be called from a
-- trigger and from a batch predicate without Postgres re-planning around it.
--
-- These numbers mirror `src/lib/trial-identity/retention.ts`, and a test asserts
-- the two agree rather than trusting that somebody will remember.
create or replace function public.trial_identity_retention_interval(input_origin text)
returns interval
language sql
immutable
as $$
  select case when input_origin = 'production_qa'
    then interval '90 days'
    else interval '1095 days'
  end
$$;

/*
 * Backfill, deterministic and re-runnable: every existing row gets the deadline
 * its own `first_claimed_at` implies under its own origin. Run twice, the second
 * pass matches nothing, because it only touches rows that have no deadline yet.
 *
 * Existing rows keep `claim_origin = 'user'`. That is not a guess about who made
 * them — it is the reading with the longest protection and the one no cleanup
 * command may delete. A row whose origin cannot be proved is treated as a
 * person's, because the cost of being wrong in that direction is a pseudonymous
 * digest kept longer than necessary, and the cost in the other direction is
 * deleting somebody's record early and handing them a second free week.
 */
update public.trial_identity_claims
set retain_until = first_claimed_at + public.trial_identity_retention_interval(claim_origin)
where retain_until is null;

-- The sweep's access path. Partial, because the only rows it ever scans are the
-- ones no live account is holding — see the purge for why.
create index if not exists trial_identity_claims_retention_idx
  on public.trial_identity_claims (retain_until)
  where claimed_by_user_id is null;

-- Answering "is any stored version one we cannot compute?" is a distinct-scan
-- over a small column, and it runs on every eligibility check.
create index if not exists trial_identity_claims_version_idx
  on public.trial_identity_claims (hash_version);

-- Stamp the deadline on the way in, whatever inserted the row.
--
-- A trigger rather than a column default because the value depends on two other
-- columns of the same row, and because it must cover every writer — the claim
-- routine, the deletion-time retention routine, and a service-role insert made by
-- hand during an incident. `before insert` only: the `on conflict do update` path
-- must not touch the deadline, or re-claiming an identity would silently extend
-- a window that started years ago.
create or replace function public.stamp_trial_identity_retention()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.retain_until is null then
    new.retain_until := coalesce(new.first_claimed_at, now())
      + public.trial_identity_retention_interval(new.claim_origin);
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_trial_identity_retention() from public, anon, authenticated;

drop trigger if exists stamp_trial_identity_retention on public.trial_identity_claims;
create trigger stamp_trial_identity_retention
  before insert on public.trial_identity_claims
  for each row execute function public.stamp_trial_identity_retention();

-- ---------------------------------------------------------------------------
-- 2. The switch that decides whether the sweep may delete anything
-- ---------------------------------------------------------------------------
--
-- Default `false`, and it stays false until legal sign-off. The sweep still runs
-- on schedule with it off — it reports how many rows are due and deletes none —
-- because a purge whose first live run is also its first *real* run is a purge
-- nobody has ever seen work.
--
-- The flag lives in the database rather than in an environment variable so that
-- turning enforcement on is a recorded change to one row, made deliberately,
-- rather than a redeploy — and so that a copy of production that was restored for
-- testing cannot inherit "on" from a shared variable.
create table if not exists public.trial_retention_config (
  singleton boolean primary key default true,
  enforcement_enabled boolean not null default false,
  batch_limit integer not null default 500,
  -- Stamped by the operator when counsel has signed off. Recorded because the
  -- question "who decided this may delete real rows, and when?" must have an
  -- answer that is not somebody's memory.
  legal_signed_off_at timestamptz,
  legal_signed_off_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint trial_retention_config_singleton_check check (singleton),
  constraint trial_retention_config_batch_check check (batch_limit between 1 and 5000)
);

alter table public.trial_retention_config
  add column if not exists enforcement_enabled boolean not null default false,
  add column if not exists batch_limit integer not null default 500,
  add column if not exists legal_signed_off_at timestamptz,
  add column if not exists legal_signed_off_by uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid;

-- `do nothing`, for the same reason the beta program row uses it: a redeploy must
-- never reset a decision an operator has made.
insert into public.trial_retention_config (singleton) values (true)
  on conflict (singleton) do nothing;

alter table public.trial_retention_config enable row level security;
-- No policy at all, so RLS denies every session unconditionally.
revoke all on table public.trial_retention_config from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The sweep's own record
-- ---------------------------------------------------------------------------
--
-- One row per run. `run_id` is unique and supplied by the caller, which is what
-- makes a retry idempotent: a run that is repeated under the same id observes the
-- first run's record and deletes nothing a second time.
--
-- The columns are the whole of what is kept: an id, a time, a mode, four counts
-- and a sanitized error. There is no identity column here and there must never be
-- one — an audit trail listing the digests it removed would be a copy of the
-- ledger that outlived the ledger.
create table if not exists public.trial_retention_runs (
  run_id uuid primary key,
  mode text not null,
  enforcement_enabled boolean not null,
  scanned integer not null default 0,
  deleted integer not null default 0,
  skipped_legal_hold integer not null default 0,
  skipped_active_holder integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint trial_retention_runs_mode_check
    check (mode in ('dry_run', 'reporting_only', 'apply')),
  -- A fixed vocabulary, so nothing a caller passes can become a free-text log
  -- line carrying whatever an exception happened to contain.
  constraint trial_retention_runs_error_check
    check (error is null or error in ('config_unreadable', 'batch_failed', 'lock_timeout'))
);

alter table public.trial_retention_runs enable row level security;
revoke all on table public.trial_retention_runs from public, anon, authenticated;

create index if not exists trial_retention_runs_started_idx
  on public.trial_retention_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- 4. The purge
-- ---------------------------------------------------------------------------
--
-- Three modes, and the difference between two of them is the point:
--
--   dry_run         the caller asked for a preview. Counts, no deletion.
--   reporting_only  the caller asked to apply, and enforcement is off. Counts,
--                   no deletion — and recorded under a *different* mode, so
--                   nobody reading the audit later has to guess whether a run
--                   deleted nothing because it was told not to or because it was
--                   not allowed to.
--   apply           enforcement is on. Deletes one bounded batch.
--
-- What it will never delete:
--
--   * a row whose `retain_until` has not passed;
--   * a row under a live legal hold;
--   * a row a live account is still holding. That row is not the record of
--     somebody who left — it is part of an existing account's own data, it is
--     removed when that account is deleted, and deleting it *early* would hand a
--     long-standing member a second free week. The retention promise is a
--     maximum, and the account's own lifetime is the shorter bound.
--
-- Bounded by design: one batch per call, `for update skip locked` so two runs
-- cannot fight, and a hard ceiling above the configured limit. A sweep that held
-- a lock across the whole table would block the one thing the table exists for.
create or replace function public.purge_expired_trial_identity_claims(
  input_run_id uuid,
  input_apply boolean default false,
  input_batch_limit integer default null
)
returns table (
  run_id uuid,
  mode text,
  enforcement_enabled boolean,
  scanned integer,
  deleted integer,
  skipped_legal_hold integer,
  skipped_active_holder integer,
  already_recorded boolean,
  error text
)
language plpgsql
security definer set search_path = ''
as $$
/*
 * This function returns a table, so every one of its output columns — `run_id`,
 * `mode`, `scanned`, `deleted` — is also a plpgsql variable in here, and
 * `trial_retention_runs` has columns by the same names. Without this directive
 * `on conflict (run_id)` is ambiguous and the function will not run at all. The
 * columns are what those names mean in every query below; the values this function
 * returns are supplied by `return query`, never by assigning an output variable.
 */
#variable_conflict use_column
declare
  config public.trial_retention_config%rowtype;
  effective_run_id uuid := coalesce(input_run_id, gen_random_uuid());
  effective_mode text;
  effective_limit integer;
  due_count integer := 0;
  held_count integer := 0;
  holder_count integer := 0;
  removed integer := 0;
  inserted_run uuid;
  existing public.trial_retention_runs%rowtype;
begin
  select * into config from public.trial_retention_config where singleton;
  if not found then
    -- Unreadable configuration is not a licence to delete. It is recorded and the
    -- run does nothing.
    insert into public.trial_retention_runs (
      run_id, mode, enforcement_enabled, error, finished_at
    )
    values (effective_run_id, 'dry_run', false, 'config_unreadable', now())
    on conflict (run_id) do nothing;
    return query
      select effective_run_id, 'dry_run'::text, false, 0, 0, 0, 0, false, 'config_unreadable'::text;
    return;
  end if;

  effective_mode := case
    when not coalesce(input_apply, false) then 'dry_run'
    when config.enforcement_enabled then 'apply'
    else 'reporting_only'
  end;

  effective_limit := least(
    greatest(coalesce(input_batch_limit, config.batch_limit), 1),
    5000
  );

  /*
   * The idempotency key. Claiming the run id *before* doing any work is what
   * makes a repeat safe: the second caller inserts nothing, reads the first
   * run's record, and returns it without touching a row.
   */
  -- Aliased because this function returns a column called `run_id`, which is an
  -- OUT variable in here: an unqualified `returning run_id` would be ambiguous.
  insert into public.trial_retention_runs as target (run_id, mode, enforcement_enabled)
  values (effective_run_id, effective_mode, config.enforcement_enabled)
  on conflict (run_id) do nothing
  returning target.run_id into inserted_run;

  if inserted_run is null then
    select * into existing from public.trial_retention_runs as prior
      where prior.run_id = effective_run_id;
    return query
      select existing.run_id, existing.mode, existing.enforcement_enabled,
             existing.scanned, existing.deleted, existing.skipped_legal_hold,
             existing.skipped_active_holder, true, existing.error;
    return;
  end if;

  -- What is due, what is being kept anyway, and why. Counted in every mode, so a
  -- reporting-only run is still a real answer to "how many rows are waiting?".
  select
    count(*) filter (
      where claim.retain_until < now()
        and claim.claimed_by_user_id is null
        and (claim.legal_hold_until is null or claim.legal_hold_until <= now())
    ),
    count(*) filter (
      where claim.retain_until < now()
        and claim.legal_hold_until is not null
        and claim.legal_hold_until > now()
    ),
    count(*) filter (
      where claim.retain_until < now()
        and claim.claimed_by_user_id is not null
    )
  into due_count, held_count, holder_count
  from public.trial_identity_claims as claim;

  if effective_mode = 'apply' then
    with expired as (
      select claim.id
      from public.trial_identity_claims as claim
      where claim.retain_until < now()
        and claim.claimed_by_user_id is null
        and (claim.legal_hold_until is null or claim.legal_hold_until <= now())
      order by claim.retain_until
      limit effective_limit
      for update skip locked
    )
    delete from public.trial_identity_claims as target
    using expired
    where target.id = expired.id;
    -- Immediately after the delete, so it is that statement's count and not a
    -- later query's. It is what this run removed, never what is left.
    get diagnostics removed = row_count;
  end if;

  update public.trial_retention_runs as target
  set scanned = due_count,
      deleted = removed,
      skipped_legal_hold = held_count,
      skipped_active_holder = holder_count,
      finished_at = now()
  where target.run_id = effective_run_id;

  return query
    select effective_run_id, effective_mode, config.enforcement_enabled,
           due_count, removed, held_count, holder_count, false, null::text;
end;
$$;

revoke all on function public.purge_expired_trial_identity_claims(uuid, boolean, integer)
  from public, anon, authenticated;

-- Place, extend or lift a legal hold.
--
-- Service-role only, keyed on the claim's own id — there is deliberately no way
-- to place a hold by identity digest, because that would require a caller to
-- *hold* a digest, and the only paths that ever do are the trusted derivations.
create or replace function public.set_trial_identity_legal_hold(
  input_claim_id uuid,
  input_hold_until timestamptz,
  input_actor uuid default null
)
returns timestamptz
language plpgsql
security definer set search_path = ''
as $$
declare
  updated timestamptz;
begin
  if input_claim_id is null then
    raise exception 'TRIAL_IDENTITY_CLAIM_REQUIRED' using errcode = '22023';
  end if;

  update public.trial_identity_claims as claim
  set legal_hold_until = input_hold_until,
      legal_hold_set_at = case when input_hold_until is null then null else now() end,
      legal_hold_set_by = case when input_hold_until is null then null else input_actor end,
      updated_at = now()
  where claim.id = input_claim_id
  returning claim.legal_hold_until into updated;

  if not found then
    raise exception 'TRIAL_IDENTITY_CLAIM_NOT_FOUND' using errcode = 'P0001';
  end if;
  return updated;
end;
$$;

revoke all on function public.set_trial_identity_legal_hold(uuid, timestamptz, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Reading the ledger safely across key versions
-- ---------------------------------------------------------------------------
--
-- `trial_identity_is_claimed` answers about the digests it is given, which is
-- correct and not sufficient: the caller can only derive digests for versions it
-- holds a key for. A claim stamped with a version whose key this deployment does
-- not have would simply not match, and "did not match" reads as "never had a
-- trial".
--
-- So the caller sends the versions it *can* compute, and this reports any stored
-- version outside that list. The caller refuses on a non-empty answer. One round
-- trip, because the two questions must be asked of the same snapshot — a lookup
-- that missed and a version list that arrived a moment later would be two facts
-- about two different tables.
create or replace function public.trial_identity_claim_status(
  input_identities jsonb,
  input_versions smallint[] default null
)
returns table (claimed boolean, unsupported_versions smallint[])
language sql
stable
security definer set search_path = ''
as $$
  select
    exists (
      select 1
      from jsonb_array_elements(coalesce(input_identities, '[]'::jsonb)) as candidate
      join public.trial_identity_claims as claim
        on claim.identity_type = candidate ->> 'type'
       and claim.identity_hash = candidate ->> 'hash'
       and claim.hash_version = (candidate ->> 'version')::smallint
    ),
    coalesce(
      (
        select array_agg(distinct claim.hash_version order by claim.hash_version)
        from public.trial_identity_claims as claim
        where input_versions is not null
          and not (claim.hash_version = any (input_versions))
      ),
      array[]::smallint[]
    )
$$;

revoke all on function public.trial_identity_claim_status(jsonb, smallint[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Where a claim came from
-- ---------------------------------------------------------------------------
--
-- `claim_trial_identity` keeps its signature and its behaviour: it writes
-- `claim_origin = 'user'` by the column default and has no way to say otherwise.
-- That is what "a normal claim cannot choose its own origin" means here — not a
-- validation, an absence.
--
-- A caller that genuinely is Production QA uses the routine below. Both are
-- service-role only, so neither is reachable from a browser; the separation is
-- about which *trusted* path was taken, so that a cleanup command can delete our
-- own test data and provably nothing else.
create or replace function public.claim_trial_identity_with_origin(
  input_user_id uuid,
  input_identity_type text,
  input_identity_hash text,
  input_hash_version smallint,
  input_origin text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  if input_user_id is null then
    raise exception 'TRIAL_IDENTITY_USER_REQUIRED' using errcode = '22023';
  end if;
  if input_origin is null or input_origin not in ('user', 'backfill', 'production_qa') then
    raise exception 'TRIAL_IDENTITY_ORIGIN_UNKNOWN' using errcode = '22023';
  end if;

  insert into public.trial_identity_claims as claim (
    identity_type, identity_hash, hash_version, claimed_by_user_id, claim_origin
  )
  values (input_identity_type, input_identity_hash, input_hash_version, input_user_id, input_origin)
  on conflict (identity_type, hash_version, identity_hash) do update
    set updated_at = now()
    where claim.claimed_by_user_id = excluded.claimed_by_user_id
  returning claim.id into claimed_id;

  if claimed_id is null then return 'already_claimed'; end if;
  return 'claimed';
end;
$$;

revoke all on function public.claim_trial_identity_with_origin(uuid, text, text, smallint, text)
  from public, anon, authenticated;

-- Relabel claims whose origin has been *proved* from operation metadata.
--
-- Takes ids, never digests, and never a predicate like "everything since
-- Tuesday": the caller has to have identified the exact rows, which is the only
-- form in which "proved" means anything. Relabelling to `production_qa` moves the
-- deadline onto the QA policy, computed from the row's own first claim — the one
-- place a stored deadline is deliberately recomputed, because the row has been
-- shown to be our own test data rather than a person's.
create or replace function public.mark_trial_identity_claim_origin(
  input_claim_ids uuid[],
  input_origin text
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer := 0;
begin
  if input_origin is null or input_origin not in ('user', 'backfill', 'production_qa') then
    raise exception 'TRIAL_IDENTITY_ORIGIN_UNKNOWN' using errcode = '22023';
  end if;
  if input_claim_ids is null or array_length(input_claim_ids, 1) is null then
    return 0;
  end if;

  update public.trial_identity_claims as claim
  set claim_origin = input_origin,
      retain_until = claim.first_claimed_at
        + public.trial_identity_retention_interval(input_origin),
      updated_at = now()
  where claim.id = any (input_claim_ids);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.mark_trial_identity_claim_origin(uuid[], text)
  from public, anon, authenticated;

-- Remove our own test claims, and provably nothing else.
--
-- Constrained three ways: only `production_qa`, only when no legal hold is in
-- force, and only rows no live account is holding. A preview run is the default
-- shape of the calling script, and this routine reports the same counts whether
-- or not it was asked to delete.
create or replace function public.delete_qa_trial_identity_claims(
  input_apply boolean default false
)
returns table (matched integer, deleted integer, skipped_legal_hold integer, skipped_active_holder integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  match_count integer := 0;
  held_count integer := 0;
  holder_count integer := 0;
  removed integer := 0;
begin
  select
    count(*) filter (
      where claim.claimed_by_user_id is null
        and (claim.legal_hold_until is null or claim.legal_hold_until <= now())
    ),
    count(*) filter (where claim.legal_hold_until is not null and claim.legal_hold_until > now()),
    count(*) filter (where claim.claimed_by_user_id is not null)
  into match_count, held_count, holder_count
  from public.trial_identity_claims as claim
  where claim.claim_origin = 'production_qa';

  if coalesce(input_apply, false) then
    delete from public.trial_identity_claims as claim
    where claim.claim_origin = 'production_qa'
      and claim.claimed_by_user_id is null
      and (claim.legal_hold_until is null or claim.legal_hold_until <= now());
    get diagnostics removed = row_count;
  end if;

  return query select match_count, removed, held_count, holder_count;
end;
$$;

revoke all on function public.delete_qa_trial_identity_claims(boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Seeing a stuck deletion
-- ---------------------------------------------------------------------------
--
-- How much of the account's own data is still there.
--
-- This is the completeness proof the reconciler requires before it will delete an
-- auth user: a lifecycle row saying `data_purged` is a claim about the past, and
-- this is a measurement of the present. Same table list as `purge_account_data`,
-- guarded on the column rather than the table for the same reason — a deployment
-- whose schema predates one of them skips it instead of failing.
create or replace function public.account_residual_data_count(input_user_id uuid)
returns integer
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  owned constant text[][] := array[
    ['support_tickets', 'user_id'],
    ['refund_requests', 'user_id'],
    ['purchase_consents', 'user_id'],
    ['option_simulations', 'user_id'],
    ['price_alerts', 'user_id'],
    ['notifications', 'user_id'],
    ['queued_notifications', 'user_id'],
    ['push_deliveries', 'user_id'],
    ['push_subscriptions', 'user_id'],
    ['notification_preferences', 'user_id'],
    ['portfolios', 'user_id'],
    ['watchlists', 'user_id'],
    ['user_settings', 'user_id'],
    ['billing_pending_payments', 'user_id'],
    ['admin_access_previews', 'user_id'],
    ['user_subscriptions', 'user_id'],
    ['user_roles', 'user_id'],
    ['profiles', 'id']
  ];
  entry text[];
  total integer := 0;
  found_rows integer;
begin
  if input_user_id is null then
    raise exception 'ACCOUNT_DELETION_USER_REQUIRED' using errcode = '22023';
  end if;

  foreach entry slice 1 in array owned loop
    if exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[1]
        and candidate.column_name = entry[2]
    ) then
      execute format('select count(*)::integer from public.%I where %I = $1', entry[1], entry[2])
        into found_rows using input_user_id;
      total := total + coalesce(found_rows, 0);
    end if;
  end loop;

  return total;
end;
$$;

revoke all on function public.account_residual_data_count(uuid) from public, anon, authenticated;

-- Every deletion that has not finished, and what would be safe to do about it.
--
-- The state is derived rather than stored, because the states worth naming are
-- not all representable as a status: an account that finished deleting leaves no
-- lifecycle row at all — the row cascades with the auth user — so "closed" is
-- observable only as an absence, and this reports what is *present*.
--
--   closing               nothing destroyed yet; the pipeline may still be
--                         re-run from the top, or cancelled back into service.
--   purge_pending         the provider is settled, so the only way is forward.
--   awaiting_auth_delete  the data is gone and the auth user is not. This is the
--                         state a failed `deleteUser` leaves, and the one an
--                         ordinary query could not see.
--
-- `stuck` is orthogonal: any of the three, older than the threshold the caller
-- passes. Read-only, and it returns account ids because its only caller is an
-- operator holding the service key.
create or replace function public.account_deletion_report(
  input_stuck_after interval default interval '1 hour'
)
returns table (
  user_id uuid,
  state text,
  stage text,
  operation_id uuid,
  requested_at timestamptz,
  updated_at timestamptz,
  age interval,
  stuck boolean,
  residual_rows integer,
  auth_user_exists boolean
)
language sql
stable
security definer set search_path = ''
as $$
  select
    lifecycle.user_id,
    case
      when lifecycle.stage = 'data_purged' then 'awaiting_auth_delete'
      when lifecycle.stage = 'provider_settled' then 'purge_pending'
      else 'closing'
    end,
    lifecycle.stage,
    lifecycle.operation_id,
    lifecycle.requested_at,
    lifecycle.updated_at,
    now() - lifecycle.updated_at,
    (now() - lifecycle.updated_at) > coalesce(input_stuck_after, interval '1 hour'),
    public.account_residual_data_count(lifecycle.user_id),
    exists (select 1 from auth.users as users where users.id = lifecycle.user_id)
  from public.account_lifecycle as lifecycle
  where lifecycle.status = 'deleting'
  order by lifecycle.updated_at
$$;

revoke all on function public.account_deletion_report(interval) from public, anon, authenticated;

-- The retention side of the same report: the flag, the schedule, what is due, and
-- when the sweep last ran. Counts only — never a digest, never an account.
create or replace function public.trial_retention_status()
returns table (
  enforcement_enabled boolean,
  batch_limit integer,
  legal_signed_off_at timestamptz,
  total_claims integer,
  due_now integer,
  held_now integer,
  held_by_live_account integer,
  qa_claims integer,
  distinct_versions smallint[],
  scheduled boolean,
  last_run_at timestamptz,
  last_run_mode text,
  last_run_deleted integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  job_scheduled boolean := false;
begin
  /*
   * Whether the sweep is actually on the scheduler.
   *
   * Asked dynamically, because `cron.job` does not exist where pg_cron is not
   * installed and a static reference to it would make this function refuse to be
   * created at all — including in the PGlite harness the migration tests run in.
   * Absent extension reports `false` rather than asserting a schedule nobody has.
   */
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)'
      into job_scheduled using 'portkheaw-trial-retention';
  end if;

  return query
  select
    coalesce((select config.enforcement_enabled from public.trial_retention_config as config where config.singleton), false),
    coalesce((select config.batch_limit from public.trial_retention_config as config where config.singleton), 0),
    (select config.legal_signed_off_at from public.trial_retention_config as config where config.singleton),
    (select count(*)::integer from public.trial_identity_claims),
    (select count(*)::integer from public.trial_identity_claims as claim
      where claim.retain_until < now()
        and claim.claimed_by_user_id is null
        and (claim.legal_hold_until is null or claim.legal_hold_until <= now())),
    (select count(*)::integer from public.trial_identity_claims as claim
      where claim.legal_hold_until is not null and claim.legal_hold_until > now()),
    (select count(*)::integer from public.trial_identity_claims as claim
      where claim.retain_until < now() and claim.claimed_by_user_id is not null),
    (select count(*)::integer from public.trial_identity_claims as claim
      where claim.claim_origin = 'production_qa'),
    coalesce((select array_agg(distinct claim.hash_version order by claim.hash_version)
      from public.trial_identity_claims as claim), array[]::smallint[]),
    job_scheduled,
    (select run.started_at from public.trial_retention_runs as run order by run.started_at desc limit 1),
    (select run.mode from public.trial_retention_runs as run order by run.started_at desc limit 1),
    (select run.deleted from public.trial_retention_runs as run order by run.started_at desc limit 1);
end;
$$;

revoke all on function public.trial_retention_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.trial_identity_retention_interval(text) to service_role;
grant execute on function public.purge_expired_trial_identity_claims(uuid, boolean, integer) to service_role;
grant execute on function public.set_trial_identity_legal_hold(uuid, timestamptz, uuid) to service_role;
grant execute on function public.trial_identity_claim_status(jsonb, smallint[]) to service_role;
grant execute on function public.claim_trial_identity_with_origin(uuid, text, text, smallint, text) to service_role;
grant execute on function public.mark_trial_identity_claim_origin(uuid[], text) to service_role;
grant execute on function public.delete_qa_trial_identity_claims(boolean) to service_role;
grant execute on function public.account_residual_data_count(uuid) to service_role;
grant execute on function public.account_deletion_report(interval) to service_role;
grant execute on function public.trial_retention_status() to service_role;

-- ---------------------------------------------------------------------------
-- 9. The schedule
-- ---------------------------------------------------------------------------
--
-- In the database, on the same scheduler the background notifications use. No
-- HTTP hop and therefore no new secret: the sweep needs nothing from outside the
-- database, and a cron endpoint would have been one more authenticated surface
-- guarding a routine that already refuses everyone but `service_role`.
--
-- It passes `input_apply => true` deliberately. With the flag at its default that
-- resolves to `reporting_only`: the job runs nightly, writes an audit row saying
-- how many rows are due, and deletes nothing. Enforcement is then a single update
-- to one row rather than a change to the schedule — which is what makes turning
-- it on after legal sign-off require no code and no redeploy.
--
-- Guarded on `cron.schedule` existing so the migration is runnable anywhere,
-- including the PGlite harness the tests use.
do $$
declare
  existing_job_id bigint;
begin
  if to_regproc('cron.schedule') is null then
    raise notice 'pg_cron is not installed; the trial retention sweep is not scheduled.';
    return;
  end if;

  select jobid into existing_job_id from cron.job where jobname = 'portkheaw-trial-retention' limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'portkheaw-trial-retention',
    '23 19 * * *',
    'select public.purge_expired_trial_identity_claims(gen_random_uuid(), true, null)'
  );
end;
$$;

commit;
