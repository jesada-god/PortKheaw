begin;

-- Phase 7 — purchase consent, and the seven days a charge can be asked back.
--
-- Additive and forward-only. No table, column, policy, grant, routine or row is
-- dropped; the two routines that change keep their names and their argument
-- lists, and the one that gains an output column is recreated with everything it
-- already returned still in place.
--
-- Two rules are being written into the database here, both of them rules that
-- cannot live in a browser:
--
--   1. **A paid checkout records what the buyer agreed to.** The consent row
--      names the account, the plan, the cadence, the rail and the *version* of
--      each policy the wording came from. A browser cannot write one: the table
--      grants `select` and nothing else, and the only writer is the routine
--      below, which takes the account from the session and never as an argument.
--
--   2. **A refund request is judged against the provider's own payment
--      timestamp.** `billing_invoices.paid_at` is written only by the webhook
--      routine, from what the provider reported, and is never overwritten once
--      set. The deadline is derived from it inside the database, so no client
--      clock, no time zone and no request parameter can move it — which is the
--      whole reason the check lives here rather than in the action that calls it.
--
-- Seven calendar days and seven times twenty-four hours are the same interval in
-- Asia/Bangkok, which observes no daylight saving. The TypeScript window adds
-- milliseconds and this adds `interval '7 days'`; the migration test asserts the
-- two agree rather than leaving a reader to notice they might not.

-- ---------------------------------------------------------------------------
-- 1. What the buyer agreed to
-- ---------------------------------------------------------------------------
--
-- Deliberately absent: a name, a mailbox, an address, an amount, a provider
-- identifier, an IP address or a user agent. A consent record has to answer one
-- question — "which account accepted which wording, for which purchase, and
-- when" — and every column here is part of that answer. Nothing else is
-- evidence of anything, and all of it would be personal data we would then have
-- to protect and eventually delete.
--
-- The row is scoped to `auth.users` with `on delete cascade`, so deleting an
-- account removes its consents with it. The account-deletion path stays whole.
create table if not exists public.purchase_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_key text not null,
  billing_interval text not null,
  payment_rail text not null,
  subscription_policy_version text not null,
  refund_policy_version text not null,
  -- The first time this exact agreement was given. Immutable: a later purchase
  -- against the same unchanged wording reaffirms it, and must not rewrite the
  -- date the account first accepted it.
  accepted_at timestamptz not null default now(),
  last_accepted_at timestamptz not null default now(),
  acceptance_count integer not null default 1,
  created_at timestamptz not null default now(),
  constraint purchase_consents_plan_key_check check (char_length(plan_key) between 1 and 64),
  constraint purchase_consents_interval_check check (billing_interval in ('month', 'year')),
  constraint purchase_consents_rail_check check (payment_rail in ('card', 'promptpay')),
  constraint purchase_consents_subscription_version_check
    check (char_length(subscription_policy_version) between 1 and 40),
  constraint purchase_consents_refund_version_check
    check (char_length(refund_policy_version) between 1 and 40),
  constraint purchase_consents_count_check check (acceptance_count >= 1)
);

-- One row per account, purchase shape and pair of policy versions. This is what
-- makes recording idempotent: pressing Confirm twice, or retrying a request that
-- already succeeded, reaffirms the same row instead of filing a second identical
-- agreement. A later policy edit changes the version and therefore the key, so
-- the new acceptance is a new row and the old one survives untouched.
create unique index if not exists purchase_consents_identity_key
  on public.purchase_consents (
    user_id, plan_key, payment_rail, subscription_policy_version, refund_policy_version
  );

create index if not exists purchase_consents_user_idx
  on public.purchase_consents (user_id, last_accepted_at desc);

alter table public.purchase_consents enable row level security;

drop policy if exists "read own purchase consents" on public.purchase_consents;
create policy "read own purchase consents" on public.purchase_consents
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Read only, and only your own. There is no insert, update or delete policy at
-- all, and none is granted: the routine below is a `security definer` and is the
-- single writer.
revoke all on table public.purchase_consents from anon, authenticated;
grant select on table public.purchase_consents to authenticated;

-- What a consent record may never do is change its own history.
--
-- The trusted routine updates exactly two columns. This refuses every other
-- edit, including one from a trusted role with a bug: the account, the purchase
-- shape, the policy versions and the original acceptance date are what the
-- record exists to preserve, and a record that can be rewritten is not evidence.
create or replace function public.reject_purchase_consent_rewrite()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.plan_key is distinct from old.plan_key
     or new.billing_interval is distinct from old.billing_interval
     or new.payment_rail is distinct from old.payment_rail
     or new.subscription_policy_version is distinct from old.subscription_policy_version
     or new.refund_policy_version is distinct from old.refund_policy_version
     or new.accepted_at is distinct from old.accepted_at
     or new.created_at is distinct from old.created_at then
    raise exception 'PURCHASE_CONSENT_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_purchase_consent_rewrite() from public, anon, authenticated;

drop trigger if exists purchase_consents_immutable on public.purchase_consents;
create trigger purchase_consents_immutable
  before update on public.purchase_consents
  for each row execute function public.reject_purchase_consent_rewrite();

-- Record an acceptance.
--
-- The account comes from the session and is never an argument, so this cannot be
-- pointed at anybody else. The *versions* are arguments, because the server that
-- rendered the wording is the only party that knows which wording it rendered —
-- and that same server has already refused any claim that does not match what it
-- publishes. This routine's job is to write the agreement down, not to decide
-- whether the reader agreed.
--
-- It grants nothing. A consent row opens no plan, changes no tier and creates no
-- invoice; the purchase that follows is a separate act with its own gate.
create or replace function public.record_purchase_consent(
  input_plan_key text,
  input_billing_interval text,
  input_payment_rail text,
  input_subscription_policy_version text,
  input_refund_policy_version text
)
returns table (consent_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  plan_text text := btrim(coalesce(input_plan_key, ''));
  interval_text text := btrim(coalesce(input_billing_interval, ''));
  rail_text text := btrim(coalesce(input_payment_rail, ''));
  subscription_version text := btrim(coalesce(input_subscription_policy_version, ''));
  refund_version text := btrim(coalesce(input_refund_policy_version, ''));
  existing_id uuid;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if char_length(plan_text) not between 1 and 64
     or interval_text not in ('month', 'year')
     or rail_text not in ('card', 'promptpay')
     or char_length(subscription_version) not between 1 and 40
     or char_length(refund_version) not between 1 and 40 then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

  select consent.id into existing_id
  from public.purchase_consents as consent
  where consent.user_id = requesting_user
    and consent.plan_key = plan_text
    and consent.payment_rail = rail_text
    and consent.subscription_policy_version = subscription_version
    and consent.refund_policy_version = refund_version
  for update;

  if found then
    update public.purchase_consents set
      last_accepted_at = statement_timestamp(),
      acceptance_count = acceptance_count + 1
    where id = existing_id;
    return query select existing_id, 'reaffirmed'::text;
    return;
  end if;

  begin
    insert into public.purchase_consents (
      user_id, plan_key, billing_interval, payment_rail,
      subscription_policy_version, refund_policy_version,
      accepted_at, last_accepted_at, created_at
    ) values (
      requesting_user, plan_text, interval_text, rail_text,
      subscription_version, refund_version,
      statement_timestamp(), statement_timestamp(), statement_timestamp()
    )
    returning id into new_id;
  exception when unique_violation then
    -- Two presses that raced. The other one won, and its row says the same
    -- thing, so this is a reaffirmation rather than a failure.
    select consent.id into new_id
    from public.purchase_consents as consent
    where consent.user_id = requesting_user
      and consent.plan_key = plan_text
      and consent.payment_rail = rail_text
      and consent.subscription_policy_version = subscription_version
      and consent.refund_policy_version = refund_version;
    return query select new_id, 'reaffirmed'::text;
    return;
  end;

  return query select new_id, 'recorded'::text;
end;
$$;

revoke all on function public.record_purchase_consent(text, text, text, text, text)
  from public, anon;
grant execute on function public.record_purchase_consent(text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The refund window, derived where it cannot be argued with
-- ---------------------------------------------------------------------------

-- The deadline for one charge, in one place.
--
-- `null` in, `null` out: an invoice that was issued and never paid has nothing
-- to refund and therefore no deadline. Not marked immutable, because
-- `timestamptz + interval` is not — which is also why this cannot be a stored
-- generated column and is a function instead.
create or replace function public.refund_request_deadline(input_paid_at timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when input_paid_at is null then null else input_paid_at + interval '7 days' end
$$;

revoke all on function public.refund_request_deadline(timestamptz) from public, anon;
grant execute on function public.refund_request_deadline(timestamptz) to authenticated;

-- The reader's own purchases, now carrying the deadline.
--
-- Recreated rather than replaced: adding an output column changes the return
-- type, which `create or replace` cannot do. Everything the projection returned
-- before is returned still, in the same order, so nothing that reads it breaks —
-- and it is still our uuid and money only, with no provider identifier anywhere
-- in it.
--
-- `database_now` was already here and is what the deadline must be judged
-- against. A caller that compares the deadline to its own clock is comparing it
-- to the wrong clock, and the surfaces that render this pass `database_now`
-- through for exactly that reason.
drop function if exists public.list_my_billing_invoices();

create function public.list_my_billing_invoices()
returns table (
  invoice_ref uuid,
  plan_key text,
  status text,
  amount_paid_minor bigint,
  amount_refunded_minor bigint,
  currency text,
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  paid_at timestamptz,
  refund_request_status text,
  refund_deadline_at timestamptz,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    invoice.id,
    invoice.plan_key,
    invoice.status,
    invoice.amount_paid_minor,
    invoice.amount_refunded_minor,
    invoice.currency,
    invoice.period_start,
    invoice.period_end,
    invoice.issued_at,
    invoice.paid_at,
    (
      select request.status from public.refund_requests as request
      where request.invoice_ref = invoice.id
      order by request.created_at desc
      limit 1
    ),
    public.refund_request_deadline(invoice.paid_at),
    statement_timestamp()
  from public.billing_invoices as invoice
  where invoice.user_id = (select auth.uid())
    and (select auth.uid()) is not null
  order by coalesce(invoice.paid_at, invoice.issued_at, invoice.created_at) desc
  limit 50
$$;

revoke all on function public.list_my_billing_invoices() from public, anon;
grant execute on function public.list_my_billing_invoices() to authenticated;

-- One undecided request per purchase, as a constraint rather than only a check.
--
-- The routine has always refused a second open request and still does; this is
-- the same rule expressed where a bug cannot step around it. Partial, so a
-- rejected or cancelled request never blocks a later one — a reader whose first
-- attempt was refused may still ask again inside the window.
create unique index if not exists refund_requests_one_active_per_invoice
  on public.refund_requests (invoice_ref)
  where status in ('pending', 'reviewing', 'approved');

-- File a refund request, inside the window.
--
-- Unchanged from the shipped routine except for one added refusal and the two
-- fields it records. Kept verbatim otherwise — same signature, same ownership
-- lookup, same rate limit, same audit row — because everything else about this
-- routine is released behaviour that this phase has no business rewriting.
--
-- The added check is the whole point of the phase:
--
--   * it reads `invoice.paid_at`, which only the webhook routine writes and only
--     from what the provider confirmed;
--   * it compares against `statement_timestamp()`, the database's own clock;
--   * it takes no timestamp, no deadline and no time zone as an argument, so
--     there is nothing here for a client to send that could move it.
--
-- A paid invoice with no `paid_at` — a shape the provider should not produce and
-- an older row might — is refused as `not_refundable` rather than being given an
-- unbounded window. That is the fail-safe direction: it sends a reader to
-- support instead of silently granting a deadline nobody can compute.
create or replace function public.create_refund_request(
  input_invoice_ref uuid,
  input_reason_category text,
  input_details text
)
returns table (request_id uuid, reference text, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  details_text text := btrim(coalesce(input_details, ''));
  invoice public.billing_invoices%rowtype;
  recent_count integer;
  new_reference text;
  new_id uuid;
  snapshot_tier text;
  deadline_at timestamptz;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_reason_category not in (
    'duplicate_charge', 'not_as_expected', 'accidental_purchase', 'technical_issue', 'other'
  ) then
    return query select null::uuid, null::text, 'invalid_reason'::text;
    return;
  end if;
  if char_length(details_text) not between 10 and 4000 then
    return query select null::uuid, null::text, 'invalid_content'::text;
    return;
  end if;

  select * into invoice
  from public.billing_invoices
  where id = input_invoice_ref and user_id = requesting_user
  for update;
  if not found then
    return query select null::uuid, null::text, 'not_found'::text;
    return;
  end if;
  if invoice.status not in ('paid', 'partially_refunded') or invoice.paid_at is null then
    return query select null::uuid, null::text, 'not_refundable'::text;
    return;
  end if;

  if exists (
    select 1 from public.refund_requests as request
    where request.invoice_ref = invoice.id
      and request.status in ('pending', 'reviewing', 'approved')
  ) then
    return query select null::uuid, null::text, 'already_open'::text;
    return;
  end if;
  if exists (
    select 1 from public.refund_requests as request
    where request.invoice_ref = invoice.id and request.status = 'refunded'
  ) then
    return query select null::uuid, null::text, 'already_refunded'::text;
    return;
  end if;

  -- The window. Inclusive of the deadline itself: seven days means the whole of
  -- the seventh day, and a request filed at the last second is inside it.
  deadline_at := public.refund_request_deadline(invoice.paid_at);
  if statement_timestamp() > deadline_at then
    return query select null::uuid, null::text, 'window_closed'::text;
    return;
  end if;

  select count(*) into recent_count
  from public.refund_requests as request
  where request.user_id = requesting_user
    and request.created_at > statement_timestamp() - interval '24 hours';
  if recent_count >= 3 then
    return query select null::uuid, null::text, 'rate_limited'::text;
    return;
  end if;

  snapshot_tier := public.resolve_effective_subscription_tier(
    requesting_user, statement_timestamp()
  );
  new_reference := public.generate_support_reference('RF');

  insert into public.refund_requests (
    reference, user_id, invoice_ref, status, reason_category, details,
    amount_minor, currency, tier_snapshot, status_changed_at, created_at, updated_at
  ) values (
    new_reference, requesting_user, invoice.id, 'pending', input_reason_category, details_text,
    greatest(invoice.amount_paid_minor - invoice.amount_refunded_minor, 0), invoice.currency,
    snapshot_tier, statement_timestamp(), statement_timestamp(), statement_timestamp()
  )
  returning id into new_id;

  insert into public.support_audit_events (
    refund_request_id, actor_user_id, actor_role, action, to_status, detail
  ) values (
    new_id, requesting_user, 'user', 'refund_requested', 'pending',
    jsonb_build_object(
      'reason', input_reason_category,
      'tierSnapshot', snapshot_tier,
      -- The deadline this request was accepted against, and the payment it was
      -- measured from. An audit row that says only "accepted" cannot later
      -- answer "was it in time?".
      'paidAt', invoice.paid_at,
      'refundDeadlineAt', deadline_at
    )
  );

  return query select new_id, new_reference, 'created'::text;
end;
$$;

revoke all on function public.create_refund_request(uuid, text, text) from public, anon;
grant execute on function public.create_refund_request(uuid, text, text) to authenticated;

commit;
