-- ---------------------------------------------------------------------------
-- One resolver decides what an account holds
-- ---------------------------------------------------------------------------
--
-- A sweep for decisions that read `user_subscriptions.tier` directly rather than
-- through the effective-tier rule found exactly one that still does: the
-- `PAID_SUBSCRIPTION_ACTIVE` guard inside the trial grant. It was not a hole —
-- it restated the period bound inline, so a `past_due` row with no period could
-- not trip it — but it was the same rule written twice, and the second copy is
-- how a rule drifts.
--
-- Everything else already goes through `resolve_effective_subscription_tier`
-- (SQL) or `resolveEffectiveTier` (TypeScript). This closes the last one.
--
-- The function body below is `202608060002`'s, verbatim apart from that guard.

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

  /*
   * The one resolver decides what this account holds.
   *
   * This test used to read `subscription.tier` and re-state the period rule
   * beside it. It happened to be bounded correctly, but a decision that reads
   * the stored column is a decision that can drift from
   * `resolve_effective_subscription_tier` — and the stored column is exactly
   * what the `missing-period-end` rows had raised without a period behind it.
   * Asking the resolver means it cannot drift.
   *
   * `status = 'active'` stays in front of it deliberately: the resolver answers
   * `elite` for a running trial too, and a trialist must be refused by
   * `TRIAL_ALREADY_ACTIVE` below, which is the sentence that makes sense to them.
   */
  if subscription.status = 'active'
    and public.resolve_effective_subscription_tier(input_user_id, granted_at) in ('pro', 'elite')
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

-- `create or replace` preserves the existing ACL, so this is a restatement
-- rather than a change: the trusted server is the only caller, and the browser
-- reaches the grant through the server action that derives the identity digests.
grant execute on function public.start_elite_trial_with_identity(uuid, jsonb) to service_role;
