begin;

-- Phase 8 — deleting an account for real, and remembering one thing about it.
--
-- Additive and forward-only. Nothing is dropped except two routine signatures
-- that are recreated in the same statement block with everything they returned
-- still in place.
--
-- Two defects are being closed here, and they are the same defect seen from two
-- sides.
--
--   1. **A spent trial was remembered only inside the account.**
--      `user_subscriptions.trial_used_at` is the only record that the one free
--      week has been taken, and that row is
--      `references auth.users(id) on delete cascade`. Deleting the account
--      therefore deleted the evidence: signing up again with the same mailbox
--      produced a fresh row with `trial_used_at is null`, and the trial was
--      granted a second time, and a third. The fix cannot live in `profiles`,
--      in a cookie or on a device — all three are the account, or worse, the
--      browser. It has to be a table that does not cascade.
--
--   2. **Deleting an account was one unguarded statement.**
--      `delete_own_account()` removed the `auth.users` row from an ordinary
--      session with no re-authentication, no provider settlement, no storage
--      cleanup and no way to resume a half-finished attempt. It is revoked
--      below and now refuses; deletion runs as a staged, resumable pipeline
--      whose last act — and only last act — is removing the auth user.
--
-- What is retained after a deletion, and why:
--
--   * one row per identity in `trial_identity_claims`, holding a keyed digest
--     and never an address, a subject or a card number. It is *pseudonymous*,
--     not anonymous: with the key, and with a candidate address to test, a row
--     can be matched. That is precisely what it is for, and it is why the key
--     lives only in the server environment.
--   * the billing and audit rows the accounting record is made of. Their
--     `user_id` columns are plain uuids with no foreign key, so once the auth
--     user is gone they point at nothing and carry no name or mailbox.
--
-- Everything else the account created is deleted before the auth user is.

-- ---------------------------------------------------------------------------
-- 1. The ledger that outlives the account
-- ---------------------------------------------------------------------------
--
-- Deliberately absent: an email address, a Google subject, a card number, an IP
-- address, a device identifier, a name. The digest is the whole record.
--
-- `claimed_by_user_id` is deliberately NOT a foreign key. A foreign key would
-- have to say what happens on delete, and both answers are wrong: `cascade`
-- deletes the very row that exists to survive, and `set null` would still tie
-- the table's lifetime to `auth.users` through a dependency it does not need.
-- It is nulled explicitly by the deletion pipeline instead, which is a step that
-- can be observed and re-run.
create table if not exists public.trial_identity_claims (
  id uuid primary key default gen_random_uuid(),
  identity_type text not null,
  -- Lower-case hex of an HMAC-SHA256. The constraint is what stops a raw
  -- address from ever being written here by a caller that skipped the hashing.
  identity_hash text not null,
  hash_version smallint not null default 1,
  -- Which live account currently holds this claim, so the same account can
  -- retry without being refused by its own earlier attempt. Null after the
  -- account is deleted — the claim stands on its own from then on.
  claimed_by_user_id uuid,
  first_claimed_at timestamptz not null default now(),
  last_account_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trial_identity_claims_type_check
    check (identity_type in ('email', 'oauth', 'payment')),
  constraint trial_identity_claims_hash_check
    check (identity_hash ~ '^[0-9a-f]{64}$'),
  constraint trial_identity_claims_version_check
    check (hash_version between 1 and 999),
  -- The uniqueness the whole feature rests on. The version is part of the key on
  -- purpose: rotating the secret produces new rows rather than colliding with
  -- old ones, and both versions keep blocking.
  constraint trial_identity_claims_identity_key
    unique (identity_type, hash_version, identity_hash)
);

create index if not exists trial_identity_claims_holder_idx
  on public.trial_identity_claims (claimed_by_user_id)
  where claimed_by_user_id is not null;

alter table public.trial_identity_claims enable row level security;

-- No policy is created, so RLS denies every session unconditionally. The table
-- is reachable only through the SECURITY DEFINER routines below, and those are
-- granted to `service_role` alone: a browser cannot read the ledger, cannot
-- write to it, and cannot probe it to learn whether an address has an account.
revoke all on table public.trial_identity_claims from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Account lifecycle
-- ---------------------------------------------------------------------------
--
-- A deletion is not instantaneous — it settles a provider subscription, clears a
-- storage bucket and removes rows from a dozen tables — and for as long as it is
-- running the account must accept no new writes, even though the reader's JWT is
-- still perfectly valid and will stay valid for the rest of its hour.
--
-- The stage is what makes the pipeline resumable *and* keeps it from ever
-- restoring a half-emptied account to service:
--
--   requested       nothing has been destroyed yet, so a provider failure here
--                   may safely put the account back into service;
--   provider_settled the subscription has been dealt with; from here the only
--                   way out is forward, and the pipeline is retried;
--   data_purged     the user's own data is gone; only the auth user remains.
create table if not exists public.account_lifecycle (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active',
  stage text,
  operation_id uuid,
  requested_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint account_lifecycle_status_check check (status in ('active', 'deleting')),
  constraint account_lifecycle_stage_check
    check (stage is null or stage in ('requested', 'provider_settled', 'data_purged')),
  constraint account_lifecycle_deleting_check
    check (status = 'active' or (stage is not null and operation_id is not null))
);

alter table public.account_lifecycle enable row level security;

-- A reader may see that their own account is being deleted, and may change
-- nothing. There is no insert, update or delete policy at all, so the only
-- writers are the definer routines below.
drop policy if exists "Users can read own lifecycle" on public.account_lifecycle;
create policy "Users can read own lifecycle" on public.account_lifecycle
  for select to authenticated using ((select auth.uid()) = user_id);

revoke insert, update, delete on table public.account_lifecycle from public, anon, authenticated;

-- True when the account may still write. An account with no row has never been
-- through this path and is active — which is what keeps the check cheap and
-- keeps every account that predates this migration working unchanged.
create or replace function public.account_is_active(input_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select not exists (
    select 1 from public.account_lifecycle as lifecycle
    where lifecycle.user_id = input_user_id
      and lifecycle.status <> 'active'
  )
$$;

revoke all on function public.account_is_active(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The write gate for a closing account
-- ---------------------------------------------------------------------------
--
-- Attached as a trigger rather than woven into a dozen RLS policies, because the
-- rule is about *who is asking*, not about which row is touched — and because a
-- trigger cannot be forgotten on the next table the way a policy predicate can.
--
-- `auth.uid() is null` is the trusted server: the deletion pipeline itself runs
-- as the service role and must be able to remove exactly the rows this refuses
-- to let the account's own session touch.
create or replace function public.reject_write_from_deleting_account()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is not null and not public.account_is_active(requesting_user) then
    raise exception 'ACCOUNT_DELETING' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.reject_write_from_deleting_account() from public, anon, authenticated;

do $$
declare
  target text;
begin
  foreach target in array array[
    'profiles', 'user_settings', 'watchlists', 'watchlist_items',
    'portfolios', 'portfolio_transactions', 'portfolio_option_positions',
    'portfolio_option_targets', 'price_alerts', 'notifications',
    'queued_notifications', 'push_subscriptions', 'notification_preferences',
    'option_simulations', 'user_subscriptions', 'purchase_consents',
    'refund_requests', 'support_tickets', 'support_thread_messages'
  ] loop
    if to_regclass('public.' || target) is not null then
      execute format('drop trigger if exists reject_write_from_deleting_account on public.%I', target);
      execute format(
        'create trigger reject_write_from_deleting_account
           before insert or update or delete on public.%I
           for each row execute function public.reject_write_from_deleting_account()',
        target
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Claiming an identity
-- ---------------------------------------------------------------------------
--
-- One statement, and that is the point. A `select` followed by an `insert` loses
-- the race that matters — two tabs, or a double-clicked button, both read "not
-- claimed", both insert, and one of them gets a trial it should not have. Here
-- the unique index decides, inside the same statement, and the loser observes
-- the winner's row rather than the state it started from.
--
-- The `where` on the conflict path is what makes a retry by the *same* account
-- succeed and an attempt by a *different* account fail: the update only fires
-- when the existing row is already held by this user, and when it does not fire
-- no row is returned at all.
create or replace function public.claim_trial_identity(
  input_user_id uuid,
  input_identity_type text,
  input_identity_hash text,
  input_hash_version smallint
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

  insert into public.trial_identity_claims as claim (
    identity_type, identity_hash, hash_version, claimed_by_user_id
  )
  values (input_identity_type, input_identity_hash, input_hash_version, input_user_id)
  on conflict (identity_type, hash_version, identity_hash) do update
    set updated_at = now()
    where claim.claimed_by_user_id = excluded.claimed_by_user_id
  returning claim.id into claimed_id;

  if claimed_id is null then return 'already_claimed'; end if;
  return 'claimed';
end;
$$;

revoke all on function public.claim_trial_identity(uuid, text, text, smallint)
  from public, anon, authenticated;

-- Whether any of the supplied identities is already spent.
--
-- Read-only, and it answers about a *set* because one person arrives as an
-- address today and as a Google subject tomorrow. Any single match is enough:
-- the strongest available evidence wins, and the weakest — a payment
-- fingerprint — is excluded by the caller, never here.
create or replace function public.trial_identity_is_claimed(input_identities jsonb)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(input_identities, '[]'::jsonb)) as candidate
    join public.trial_identity_claims as claim
      on claim.identity_type = candidate ->> 'type'
     and claim.identity_hash = candidate ->> 'hash'
     and claim.hash_version = (candidate ->> 'version')::smallint
  )
$$;

revoke all on function public.trial_identity_is_claimed(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Granting the trial, atomically with the claim
-- ---------------------------------------------------------------------------
--
-- The claim and the grant are one transaction. Claiming first and granting after
-- would leave an identity burned by an attempt that failed — the account could
-- then never have the week it never got — and granting first would leave a trial
-- nobody recorded. Neither is acceptable, and neither is possible here.
--
-- The account is an argument because the caller is the trusted server, which
-- read it from a verified session and derived the identity digests itself. No
-- browser can reach this routine: it is granted to `service_role` only, and
-- `start_elite_trial()` — which a browser *could* reach — is revoked below for
-- exactly this reason. A trial that skipped the ledger is the whole defect.
create or replace function public.start_elite_trial_with_identity(
  input_user_id uuid,
  input_identities jsonb
)
returns table (
  user_id uuid,
  tier text,
  status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  database_now timestamptz
)
language plpgsql
security definer set search_path = ''
as $$
declare
  mailbox_confirmed_at timestamptz;
  subscription public.user_subscriptions%rowtype;
  granted_at timestamptz := now();
  candidate jsonb;
  outcome text;
  binding_count integer := 0;
begin
  if input_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not public.account_is_active(input_user_id) then
    raise exception 'ACCOUNT_DELETING' using errcode = '42501';
  end if;

  select users.email_confirmed_at into mailbox_confirmed_at
  from auth.users as users
  where users.id = input_user_id;
  if mailbox_confirmed_at is null then
    raise exception 'EMAIL_NOT_VERIFIED' using errcode = 'P0001';
  end if;

  select * into subscription
  from public.user_subscriptions as current_row
  where current_row.user_id = input_user_id
  for update;
  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if subscription.status = 'active'
    and subscription.tier in ('pro', 'elite')
    and subscription.current_period_end is not null
    and subscription.current_period_end > granted_at
  then
    raise exception 'PAID_SUBSCRIPTION_ACTIVE' using errcode = 'P0001';
  end if;

  if subscription.status = 'trialing'
    and subscription.trial_ends_at is not null
    and subscription.trial_ends_at > granted_at
  then
    raise exception 'TRIAL_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;

  if subscription.trial_used_at is not null then
    raise exception 'TRIAL_ALREADY_USED' using errcode = 'P0001';
  end if;

  /*
   * Every binding identity must be claimable. A payment fingerprint is recorded
   * by the deletion path as a signal but is never sent here, so it can never be
   * the reason somebody is refused — a card is shared, reissued and used to pay
   * for other people's accounts, and blocking on one would refuse a trial to
   * somebody who has never had one.
   */
  for candidate in select * from jsonb_array_elements(coalesce(input_identities, '[]'::jsonb))
  loop
    if (candidate ->> 'type') = 'payment' then
      raise exception 'TRIAL_IDENTITY_NOT_BINDING' using errcode = '22023';
    end if;
    outcome := public.claim_trial_identity(
      input_user_id,
      candidate ->> 'type',
      candidate ->> 'hash',
      (candidate ->> 'version')::smallint
    );
    if outcome <> 'claimed' then
      raise exception 'TRIAL_IDENTITY_ALREADY_USED' using errcode = 'P0001';
    end if;
    binding_count := binding_count + 1;
  end loop;

  -- No identity at all means no way to remember this trial, and a trial nobody
  -- can remember is the defect this migration exists to close.
  if binding_count = 0 then
    raise exception 'TRIAL_IDENTITY_UNAVAILABLE' using errcode = 'P0001';
  end if;

  update public.user_subscriptions as target
  set tier = 'elite',
      status = 'trialing',
      trial_started_at = granted_at,
      trial_ends_at = granted_at + interval '7 days',
      trial_used_at = granted_at
  where target.user_id = input_user_id;

  return query
  select
    target.user_id,
    target.tier,
    target.status,
    target.trial_started_at,
    target.trial_ends_at,
    target.trial_used_at,
    statement_timestamp()
  from public.user_subscriptions as target
  where target.user_id = input_user_id;
end;
$$;

revoke all on function public.start_elite_trial_with_identity(uuid, jsonb)
  from public, anon, authenticated;

-- The pre-ledger grant, closed.
--
-- It is still here so that nothing referring to it breaks, and it still refuses
-- for all the reasons it always did — but it can no longer grant anything,
-- because a browser could call it directly over PostgREST and take a trial that
-- the identity ledger never saw. That is the bypass, and revoking the grant is
-- the only way to close it.
revoke execute on function public.start_elite_trial() from authenticated;

-- ---------------------------------------------------------------------------
-- 6. Deletion pipeline
-- ---------------------------------------------------------------------------
--
-- Every routine here is idempotent and every one is granted to `service_role`
-- only. The order is fixed and each stage is recorded, so an attempt that dies
-- between two of them resumes rather than starting over.

-- Stage one. Marks the account closing and reports what the caller needs in
-- order to run the rest: the operation to log under, and whether this account
-- ever took the trial — which must be read *before* the subscription row is
-- removed, because afterwards nothing knows.
create or replace function public.begin_account_deletion(input_user_id uuid)
returns table (operation_id uuid, stage text, trial_used boolean, resumed boolean)
language plpgsql
security definer set search_path = ''
as $$
declare
  lifecycle public.account_lifecycle%rowtype;
  inserted_id uuid;
  was_resumed boolean := false;
begin
  if input_user_id is null then
    raise exception 'ACCOUNT_DELETION_USER_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users as users where users.id = input_user_id) then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;

  -- The first request creates the row. A second one conflicts and returns
  -- nothing, which is how a resumed attempt is told apart from a fresh one
  -- without a read that a concurrent caller could outrun.
  insert into public.account_lifecycle (
    user_id, status, stage, operation_id, requested_at, updated_at
  )
  values (input_user_id, 'deleting', 'requested', gen_random_uuid(), now(), now())
  on conflict (user_id) do nothing
  returning user_id into inserted_id;

  select * into lifecycle
  from public.account_lifecycle as existing
  where existing.user_id = input_user_id
  for update;

  if lifecycle.status <> 'deleting' then
    -- The account has a lifecycle row from an earlier cancelled attempt.
    update public.account_lifecycle as target
    set status = 'deleting',
        stage = 'requested',
        operation_id = coalesce(target.operation_id, gen_random_uuid()),
        requested_at = now(),
        updated_at = now()
    where target.user_id = input_user_id
    returning * into lifecycle;
  elsif inserted_id is null then
    -- Already closing when we arrived: keep the stage it reached and resume.
    was_resumed := true;
  end if;

  return query
  select
    lifecycle.operation_id,
    lifecycle.stage,
    exists (
      select 1 from public.user_subscriptions as subscription
      where subscription.user_id = input_user_id
        and subscription.trial_used_at is not null
    ),
    was_resumed;
end;
$$;

revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;

-- Move the pipeline forward one stage. Monotonic: a stage never goes backwards,
-- so a retry that re-runs an already-completed step cannot un-record it.
create or replace function public.advance_account_deletion(input_user_id uuid, input_stage text)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  ordering constant text[] := array['requested', 'provider_settled', 'data_purged'];
  current_rank integer;
  next_rank integer;
  lifecycle public.account_lifecycle%rowtype;
begin
  next_rank := array_position(ordering, input_stage);
  if next_rank is null then
    raise exception 'ACCOUNT_DELETION_STAGE_UNKNOWN' using errcode = '22023';
  end if;

  select * into lifecycle
  from public.account_lifecycle as existing
  where existing.user_id = input_user_id and existing.status = 'deleting'
  for update;
  if not found then
    raise exception 'ACCOUNT_DELETION_NOT_STARTED' using errcode = '42501';
  end if;

  current_rank := coalesce(array_position(ordering, lifecycle.stage), 1);
  if next_rank > current_rank then
    update public.account_lifecycle as target
    set stage = input_stage, updated_at = now()
    where target.user_id = input_user_id;
    return input_stage;
  end if;
  return lifecycle.stage;
end;
$$;

revoke all on function public.advance_account_deletion(uuid, text) from public, anon, authenticated;

-- The only way back to service, and it exists for exactly one situation: the
-- payment provider could not be reached before anything was destroyed. Past
-- that point there is nothing to restore *to* — an account whose portfolios are
-- half deleted must not be handed back to its owner as though it were intact —
-- so this refuses, and the operator retries the pipeline instead.
create or replace function public.cancel_account_deletion(input_user_id uuid)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  lifecycle public.account_lifecycle%rowtype;
begin
  select * into lifecycle
  from public.account_lifecycle as existing
  where existing.user_id = input_user_id
  for update;
  if not found or lifecycle.status = 'active' then return 'active'; end if;

  if lifecycle.stage is distinct from 'requested' then
    raise exception 'ACCOUNT_DELETION_IRREVERSIBLE' using errcode = 'P0001';
  end if;

  update public.account_lifecycle as target
  set status = 'active', stage = null, operation_id = null, requested_at = null, updated_at = now()
  where target.user_id = input_user_id;
  return 'active';
end;
$$;

revoke all on function public.cancel_account_deletion(uuid) from public, anon, authenticated;

-- Write the account's spent trial into the ledger, before anything is deleted.
--
-- Called with the digests the trusted server derived from the account's own
-- verified mailbox and provider identities. A digest already held by a *different*
-- live account is left exactly as it is: it already blocks, and overwriting it
-- would move somebody else's claim onto a person who is leaving.
--
-- When the account never took a trial, any claim it is still holding is an
-- orphan from an attempt that failed after claiming, and is released — otherwise
-- a failed attempt would cost a person the week they never received.
create or replace function public.retain_trial_identity_on_deletion(
  input_user_id uuid,
  input_identities jsonb,
  input_trial_used boolean
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  candidate jsonb;
  retained integer := 0;
begin
  if not input_trial_used then
    delete from public.trial_identity_claims
    where claimed_by_user_id = input_user_id;
    return 0;
  end if;

  for candidate in select * from jsonb_array_elements(coalesce(input_identities, '[]'::jsonb))
  loop
    insert into public.trial_identity_claims as claim (
      identity_type, identity_hash, hash_version,
      claimed_by_user_id, last_account_deleted_at
    )
    values (
      candidate ->> 'type', candidate ->> 'hash', (candidate ->> 'version')::smallint,
      null, now()
    )
    on conflict (identity_type, hash_version, identity_hash) do update
      set claimed_by_user_id = null,
          last_account_deleted_at = now(),
          updated_at = now()
      where claim.claimed_by_user_id is null
         or claim.claimed_by_user_id = input_user_id;
    retained := retained + 1;
  end loop;

  -- Any claim this account still holds under an older hash version, or from an
  -- identity it no longer carries, is released from the account and kept.
  update public.trial_identity_claims
  set claimed_by_user_id = null,
      last_account_deleted_at = coalesce(last_account_deleted_at, now()),
      updated_at = now()
  where claimed_by_user_id = input_user_id;

  return retained;
end;
$$;

revoke all on function public.retain_trial_identity_on_deletion(uuid, jsonb, boolean)
  from public, anon, authenticated;

-- Remove everything the account created, and anonymize what accounting and audit
-- require us to keep.
--
-- Explicit rather than relying on `on delete cascade`, for two reasons: the auth
-- user is deleted *last* and may fail, and this must still leave nothing of the
-- person behind if it does; and a step that is written down is a step that can
-- be re-run, which is what makes the whole pipeline resumable.
create or replace function public.purge_account_data(input_user_id uuid)
returns void
language plpgsql
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
  anonymized constant text[][] := array[
    ['support_thread_messages', 'author_user_id'],
    ['support_attachments', 'uploaded_by'],
    ['beta_funnel_events', 'user_id']
  ];
  entry text[];
begin
  if input_user_id is null then
    raise exception 'ACCOUNT_DELETION_USER_REQUIRED' using errcode = '22023';
  end if;

  -- Severed first: these rows survive the person, so the link to them must be
  -- cut before the rows they hang off are removed.
  --
  -- Each step is guarded on the *column* rather than the table, so a deployment
  -- whose schema predates one of these tables — or names its owner column
  -- differently — skips that step instead of aborting the purge halfway.
  foreach entry slice 1 in array anonymized loop
    if exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[1]
        and candidate.column_name = entry[2]
    ) then
      execute format('update public.%I set %I = null where %I = $1', entry[1], entry[2], entry[2])
        using input_user_id;
    end if;
  end loop;

  foreach entry slice 1 in array owned loop
    if exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[1]
        and candidate.column_name = entry[2]
    ) then
      execute format('delete from public.%I where %I = $1', entry[1], entry[2])
        using input_user_id;
    end if;
  end loop;

  /*
   * Deliberately kept: `billing_invoices`, `billing_webhook_events`,
   * `billing_refund_events`, `admin_audit_events` and `support_audit_events`.
   * They are the accounting and audit record, they carry no name, mailbox,
   * address or card, and their `user_id` columns have no foreign key — so once
   * the auth user is gone the value is an identifier that resolves to nobody.
   */
end;
$$;

revoke all on function public.purge_account_data(uuid) from public, anon, authenticated;

-- The pre-pipeline deletion, closed.
--
-- It removed the auth user from an ordinary session in one statement: no
-- re-authentication, no provider settlement, no storage cleanup, and — the
-- defect this migration exists for — no chance to write the trial ledger before
-- the evidence cascaded away. Kept as a named refusal so that any caller still
-- reaching for it fails loudly instead of silently doing the wrong thing.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  raise exception 'ACCOUNT_DELETION_REQUIRES_PIPELINE' using errcode = '42501';
end;
$$;

revoke all on function public.delete_own_account() from public, anon, authenticated;

grant execute on function public.account_is_active(uuid) to service_role;
grant execute on function public.claim_trial_identity(uuid, text, text, smallint) to service_role;
grant execute on function public.trial_identity_is_claimed(jsonb) to service_role;
grant execute on function public.start_elite_trial_with_identity(uuid, jsonb) to service_role;
grant execute on function public.begin_account_deletion(uuid) to service_role;
grant execute on function public.advance_account_deletion(uuid, text) to service_role;
grant execute on function public.cancel_account_deletion(uuid) to service_role;
grant execute on function public.retain_trial_identity_on_deletion(uuid, jsonb, boolean) to service_role;
grant execute on function public.purge_account_data(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Telling the reader
-- ---------------------------------------------------------------------------
--
-- The signature gains one column, which a `create or replace` cannot do, so the
-- routine is dropped and recreated with everything it already returned still in
-- place. `account_status` is what lets every protected surface refuse a session
-- whose account is closing without waiting for its JWT to expire.
drop function if exists public.get_my_account_access();
create function public.get_my_account_access()
returns table (
  user_id uuid,
  role text,
  preview_mode text,
  preview_expires_at timestamptz,
  tier text,
  status text,
  trial_ends_at timestamptz,
  trial_used_at timestamptz,
  current_period_end timestamptz,
  account_status text,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    viewer.user_id,
    coalesce(roles.role, 'user'),
    case
      when roles.role = 'admin'
        and preview.mode is not null
        and preview.expires_at > statement_timestamp()
        then preview.mode
      else 'actual'
    end,
    case
      when roles.role = 'admin'
        and preview.mode is not null
        and preview.expires_at > statement_timestamp()
        then preview.expires_at
      else null
    end,
    coalesce(subscription.tier, 'basic'),
    coalesce(subscription.status, 'basic'),
    subscription.trial_ends_at,
    subscription.trial_used_at,
    subscription.current_period_end,
    coalesce(lifecycle.status, 'active'),
    statement_timestamp()
  from (select auth.uid() as user_id) as viewer
  left join public.user_roles as roles on roles.user_id = viewer.user_id
  left join public.admin_access_previews as preview on preview.user_id = viewer.user_id
  left join public.user_subscriptions as subscription on subscription.user_id = viewer.user_id
  left join public.account_lifecycle as lifecycle on lifecycle.user_id = viewer.user_id
  where viewer.user_id is not null
$$;

revoke all on function public.get_my_account_access() from public, anon;
grant execute on function public.get_my_account_access() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The write gates, with one more reason to refuse
-- ---------------------------------------------------------------------------
--
-- Bodies unchanged apart from the added assertion, which is placed first: an
-- account that is closing is refused before any tier, limit or ownership rule is
-- consulted, because none of those answers matter for a session that must write
-- nothing at all.
create or replace function public.assert_portfolio_writable(target_portfolio uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  owner_id uuid;
  portfolio_kind text;
  effective_tier text;
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is not null and not public.account_is_active(requesting_user) then
    raise exception 'ACCOUNT_DELETING' using errcode = '42501';
  end if;

  select portfolio.user_id, portfolio.portfolio_type
    into owner_id, portfolio_kind
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio
    and portfolio.user_id = requesting_user;
  if owner_id is null then
    raise exception 'Portfolio not found' using errcode = '42501';
  end if;

  effective_tier := public.resolve_effective_access_tier(owner_id, statement_timestamp());
  if effective_tier <> 'basic' then
    return;
  end if;

  if portfolio_kind = 'OPTION' then
    raise exception 'UPGRADE_REQUIRED:portfolio.options.write' using errcode = 'P0001';
  end if;

  if portfolio_kind = 'STOCK'
    and target_portfolio is distinct from public.basic_writable_stock_portfolio(owner_id)
  then
    raise exception 'READ_ONLY_SUBSCRIPTION:portfolio.stock.write' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_portfolio_writable(uuid) from public, anon, authenticated;

create or replace function public.assert_options_writable()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.account_is_active(requesting_user) then
    raise exception 'ACCOUNT_DELETING' using errcode = '42501';
  end if;
  if public.resolve_effective_access_tier(requesting_user, statement_timestamp()) = 'basic' then
    raise exception 'UPGRADE_REQUIRED:portfolio.options.write' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_options_writable() from public, anon, authenticated;

commit;
