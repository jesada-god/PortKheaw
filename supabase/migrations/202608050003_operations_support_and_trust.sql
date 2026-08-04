begin;

-- Phase 5 — billing operations, support and the trust surface.
--
-- Everything here is additive and forward-only. No table, column, index, policy,
-- grant, trigger or row from Phase 1–4.4 is dropped, and no data is rewritten.
-- Three existing routines are replaced, all with their signatures unchanged:
--
--   * `apply_billing_subscription_event()` gains one rule — the revocation hold
--     described in section 3 — and is otherwise byte-for-byte the Phase 4.4 body.
--   * `handle_new_user()` is NOT touched. There is deliberately no second auth
--     trigger in this migration.
--
-- The shape of the phase:
--
--   1. `is_platform_admin()` — the one trusted role predicate every policy and
--      every operator routine below reads. Roles are never inferred from an
--      email, a display name or anything a client sends.
--   2. `billing_invoices` — what the provider actually billed and collected.
--      Written only by the webhook. It is what makes "paid invoice but no active
--      tier" a question the database can answer, and what a refund request points
--      at without a Stripe identifier ever reaching a browser.
--   3. Refunds, disputes and the entitlement policy they carry.
--   4. `billing_webhook_retries` — bounded retry and the dead-letter escalation.
--   5. Reconciliation runs and their deduplicated issues.
--   6. Support tickets, refund requests, their shared message thread, their
--      shared attachment index and their shared append-only audit.
--   7. The private attachment bucket.
--
-- One principle runs through all of it: a client may describe a problem, and may
-- never decide an outcome. Every status that carries money or access is written
-- by a trusted routine that reads the caller from `auth.uid()`, checks the role
-- in the database, and refuses on its own terms.

-- ---------------------------------------------------------------------------
-- 1. The trusted role predicate
-- ---------------------------------------------------------------------------
--
-- `security definer`, so it reads `public.user_roles` past that table's own
-- row-level security and can therefore answer "is this account an operator?"
-- from inside a policy. It takes a user id rather than reading `auth.uid()`
-- itself, so the operator routines can also use it for the caller they already
-- resolved.
--
-- A missing row, a null argument and an unrecognised role all answer false.
-- Fail closed: the failure mode of this function is losing operator access, not
-- granting it.
create or replace function public.is_platform_admin(input_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles as viewer
    where viewer.user_id = input_user_id and viewer.role = 'admin'
  )
$$;

revoke all on function public.is_platform_admin(uuid) from public, anon;
grant execute on function public.is_platform_admin(uuid) to authenticated;

-- A shared `updated_at` trigger for the tables below, so none of them has to
-- trust a caller to stamp its own clock.
create or replace function public.set_operations_updated_at()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

revoke all on function public.set_operations_updated_at() from public, anon, authenticated;

-- Audit rows are evidence. They may be inserted and read, never edited or
-- removed — including by a trusted routine with a bug, which is why this is a
-- trigger and not a convention.
create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
end;
$$;

revoke all on function public.reject_audit_mutation() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Access revocation columns
-- ---------------------------------------------------------------------------
--
-- A refund or a chargeback ends paid access. The *evidence* of what was bought —
-- plan, interval, period, invoice, customer, the provider's own event clock — is
-- never overwritten to achieve that; the status is moved to `expired`, which is
-- what both `resolve_effective_subscription_tier` and the application's
-- `resolveEffectiveTier` already read, and these three columns record why.
--
-- `access_revoked_restore_status` exists for exactly one case: a dispute we
-- later win. The suspension is meant to be reversible, and reversing it needs
-- the status the account held before it.
alter table public.user_subscriptions
  add column if not exists access_revoked_at timestamptz,
  add column if not exists access_revoked_reason text,
  add column if not exists access_revoked_restore_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_access_revoked_reason_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_access_revoked_reason_check
      check (access_revoked_reason is null or access_revoked_reason in ('refund', 'dispute'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The invoice ledger
-- ---------------------------------------------------------------------------
--
-- One row per provider invoice, written only from a verified webhook. It is the
-- record of what was billed and what was collected, and it exists for three
-- jobs the product could not otherwise do:
--
--   * a reader can point a refund request at a specific purchase — by *our*
--     uuid, never by the provider's invoice identifier, which is why the
--     sanitized projection below exists and the table itself is not granted;
--   * reconciliation can ask whether a paid invoice actually opened a tier;
--   * an operator can read a billing history without opening the provider's
--     dashboard, and without any card detail existing to be read.
--
-- Deliberately absent: card numbers, card brands, expiry, cardholder name,
-- billing address, receipt URLs. The rail (`card` or `promptpay`) is a *type*
-- and is derived from `user_subscriptions.billing_collection_method`; nothing
-- resembling a payment credential is stored anywhere in this schema.
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'stripe',
  provider_mode text not null,
  invoice_id text not null,
  subscription_id text,
  plan_key text,
  status text not null default 'open',
  amount_due_minor bigint not null default 0,
  amount_paid_minor bigint not null default 0,
  amount_refunded_minor bigint not null default 0,
  currency text not null default 'thb',
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_invoices_provider_check check (provider in ('stripe')),
  constraint billing_invoices_provider_mode_check check (provider_mode in ('test', 'live')),
  constraint billing_invoices_status_check check (status in (
    'open', 'paid', 'void', 'uncollectible', 'refunded', 'partially_refunded', 'disputed'
  )),
  constraint billing_invoices_amounts_check check (
    amount_due_minor >= 0 and amount_paid_minor >= 0 and amount_refunded_minor >= 0
  )
);

create unique index if not exists billing_invoices_provider_invoice_key
  on public.billing_invoices (provider, provider_mode, invoice_id);
create index if not exists billing_invoices_user_idx
  on public.billing_invoices (user_id, issued_at desc);
create index if not exists billing_invoices_status_idx
  on public.billing_invoices (status, updated_at desc);

alter table public.billing_invoices enable row level security;

drop policy if exists "read own invoices" on public.billing_invoices;
create policy "read own invoices" on public.billing_invoices
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin((select auth.uid())));

-- No grant at all. The policy above is defence in depth against a future grant;
-- the only way a browser sees an invoice is the sanitized projection in
-- section 10, which returns our uuid and never the provider's identifier.
revoke all on table public.billing_invoices from anon, authenticated;

drop trigger if exists billing_invoices_set_updated_at on public.billing_invoices;
create trigger billing_invoices_set_updated_at
  before update on public.billing_invoices
  for each row execute function public.set_operations_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Refunds and disputes
-- ---------------------------------------------------------------------------
--
-- The ledger of money going back, and the one documented policy it applies.
--
--   full refund        → paid access ends at the provider's refund timestamp.
--   partial refund     → recorded, and nothing else. A partial refund is a price
--                        adjustment, not an unwinding of the purchase, and
--                        downgrading somebody who was refunded 200 baht of 7,990
--                        would be a bug that costs a customer.
--   dispute opened     → paid access is suspended, and operators are alerted.
--                        The money is already gone from the merchant's side and
--                        the outcome is weeks away; suspending is reversible,
--                        and doing nothing is not.
--   dispute won by us  → the suspension is lifted and the prior status restored,
--                        provided the period it belongs to is still running.
--   dispute lost       → the suspension becomes a revocation.
--
-- No user row, portfolio, watchlist, alert, simulation or ticket is deleted by
-- any of it. A revoked account is a Basic account, which is a downgrade, not an
-- erasure — the same rule the rest of the product already follows.
create table if not exists public.billing_refund_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe',
  provider_mode text not null,
  provider_event_id text not null,
  event_type text not null,
  kind text not null,
  entitlement_action text not null,
  outcome text not null default 'recorded',
  entitlement_changed boolean not null default false,
  user_id uuid,
  subscription_id text,
  invoice_id text,
  charge_id text,
  amount_minor bigint not null default 0,
  charge_amount_minor bigint,
  currency text not null default 'thb',
  is_full boolean not null default false,
  dispute_outcome text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint billing_refund_events_provider_check check (provider in ('stripe')),
  constraint billing_refund_events_provider_mode_check check (provider_mode in ('test', 'live')),
  constraint billing_refund_events_kind_check check (kind in (
    'refund', 'dispute_opened', 'dispute_closed'
  )),
  constraint billing_refund_events_action_check check (entitlement_action in (
    'revoke', 'suspend', 'restore', 'record_only'
  ))
);

create unique index if not exists billing_refund_events_provider_event_key
  on public.billing_refund_events (provider, provider_mode, provider_event_id);
create index if not exists billing_refund_events_user_idx
  on public.billing_refund_events (user_id, occurred_at desc);
create index if not exists billing_refund_events_invoice_idx
  on public.billing_refund_events (invoice_id);

alter table public.billing_refund_events enable row level security;
revoke all on table public.billing_refund_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Bounded retry and the dead letter
-- ---------------------------------------------------------------------------
--
-- A delivery that fails for a transient reason must be retried; a delivery that
-- fails forever must stop being retried and start being somebody's problem.
--
-- The provider owns the transport schedule — we cannot make Stripe redeliver
-- sooner or later than it chooses. What we own is *how many* failures we will
-- keep asking for and what happens at the end of them. Each failure increments
-- `attempt_count` and records the backoff we consider reasonable in
-- `next_attempt_at`; a redelivery arriving earlier is still processed, because
-- refusing it would be strictly worse than handling it. Once `attempt_count`
-- reaches the bound the row is dead-lettered, operators are notified, and the
-- endpoint answers 200 so the provider stops — an event that has failed that
-- many times will not succeed on the eleventh, and an unbounded retry loop is
-- how a provider disables a webhook endpoint entirely.
--
-- A later success resolves the row rather than deleting it. The failure is
-- evidence too.
create table if not exists public.billing_webhook_retries (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe',
  provider_mode text not null,
  provider_event_id text not null,
  event_type text not null,
  user_id uuid,
  attempt_count integer not null default 0,
  status text not null default 'retrying',
  last_error_code text,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  next_attempt_at timestamptz,
  dead_lettered_at timestamptz,
  resolved_at timestamptz,
  alerted_at timestamptz,
  constraint billing_webhook_retries_provider_check check (provider in ('stripe')),
  constraint billing_webhook_retries_provider_mode_check check (provider_mode in ('test', 'live')),
  constraint billing_webhook_retries_status_check check (status in (
    'retrying', 'dead_letter', 'resolved'
  ))
);

create unique index if not exists billing_webhook_retries_provider_event_key
  on public.billing_webhook_retries (provider, provider_mode, provider_event_id);
create index if not exists billing_webhook_retries_status_idx
  on public.billing_webhook_retries (status, next_attempt_at);

alter table public.billing_webhook_retries enable row level security;
revoke all on table public.billing_webhook_retries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reconciliation
-- ---------------------------------------------------------------------------
--
-- Once a day the scheduler compares what was billed with what is granted, and
-- writes down every disagreement. It never fixes one.
--
-- That restraint is the whole design. An automatic "repair" that grants a tier
-- is a second, unsigned path to paid access; an automatic repair that withdraws
-- one takes away access somebody paid for on the strength of a query. Both are
-- worse than an operator reading a list. Issues are therefore deduplicated by a
-- stable key and re-stamped, so a condition that persists for a week is one row
-- with a count, not seven hundred.
create table if not exists public.billing_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  local_date date not null,
  provider_mode text not null,
  status text not null default 'running',
  checked_count integer not null default 0,
  issue_count integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  constraint billing_reconciliation_runs_mode_check check (provider_mode in ('test', 'live')),
  constraint billing_reconciliation_runs_status_check check (status in (
    'running', 'completed', 'failed'
  ))
);

create unique index if not exists billing_reconciliation_runs_day_key
  on public.billing_reconciliation_runs (local_date, provider_mode);

alter table public.billing_reconciliation_runs enable row level security;
revoke all on table public.billing_reconciliation_runs from anon, authenticated;

create table if not exists public.billing_reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  issue_type text not null,
  severity text not null default 'warning',
  user_id uuid,
  provider_mode text,
  detail jsonb not null default '{}'::jsonb,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_run_id uuid references public.billing_reconciliation_runs(id) on delete set null,
  resolved_at timestamptz,
  constraint billing_reconciliation_issues_type_check check (issue_type in (
    'paid_invoice_without_active_tier',
    'active_tier_without_confirmed_payment',
    'tier_period_mismatch',
    'orphan_customer',
    'orphan_subscription',
    'revoked_access_still_active',
    'dead_letter_event'
  )),
  constraint billing_reconciliation_issues_severity_check check (severity in (
    'info', 'warning', 'critical'
  ))
);

create unique index if not exists billing_reconciliation_issues_dedupe_key
  on public.billing_reconciliation_issues (dedupe_key);
create index if not exists billing_reconciliation_issues_open_idx
  on public.billing_reconciliation_issues (issue_type, last_seen_at desc)
  where resolved_at is null;
create index if not exists billing_reconciliation_issues_user_idx
  on public.billing_reconciliation_issues (user_id, last_seen_at desc);

alter table public.billing_reconciliation_issues enable row level security;
revoke all on table public.billing_reconciliation_issues from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Support tickets
-- ---------------------------------------------------------------------------
--
-- The reader supplies a category, a subject and a description. Everything else —
-- who they are, what they were paying for when they wrote it, when it happened,
-- and what state the ticket is in — is written by the routine, from the session
-- and the database clock. There is no insert or update grant on this table at
-- all, so a client holding a valid session cannot set its own status, forge a
-- tier snapshot, or file a ticket as somebody else.
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  subject text not null,
  description text not null,
  status text not null default 'open',
  tier_snapshot text not null default 'basic',
  status_changed_at timestamptz not null default now(),
  last_user_reply_at timestamptz,
  last_admin_reply_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_tickets_category_check check (category in (
    'billing', 'subscription', 'portfolio', 'market_data', 'technical', 'suggestion', 'other'
  )),
  constraint support_tickets_status_check check (status in (
    'open', 'in_progress', 'waiting_user', 'resolved', 'closed'
  )),
  constraint support_tickets_subject_check check (char_length(subject) between 3 and 160),
  constraint support_tickets_description_check check (char_length(description) between 10 and 4000),
  constraint support_tickets_tier_check check (tier_snapshot in ('basic', 'pro', 'elite'))
);

create unique index if not exists support_tickets_reference_key
  on public.support_tickets (reference);
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, updated_at desc);

alter table public.support_tickets enable row level security;

drop policy if exists "read own or operated tickets" on public.support_tickets;
create policy "read own or operated tickets" on public.support_tickets
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin((select auth.uid())));

revoke all on table public.support_tickets from anon, authenticated;
grant select on table public.support_tickets to authenticated;

drop trigger if exists support_tickets_set_updated_at on public.support_tickets;
create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_operations_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Refund requests
-- ---------------------------------------------------------------------------
--
-- A request is a request. Filing one moves no money and withdraws no access;
-- approving one moves no money either. `refunded` is reachable only from a
-- provider-confirmed refund event or from an operator recording a completion
-- they performed at the provider — the transition rules in section 10 enforce
-- that, and this table holds no provider identifier a client could aim at.
--
-- `invoice_ref` is our uuid, so a crafted request naming another account's
-- purchase fails the ownership check rather than disclosing that the purchase
-- exists.
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_ref uuid references public.billing_invoices(id) on delete set null,
  status text not null default 'pending',
  reason_category text not null,
  details text not null,
  amount_minor bigint,
  currency text,
  tier_snapshot text not null default 'basic',
  status_changed_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  refunded_at timestamptz,
  refund_event_id uuid references public.billing_refund_events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refund_requests_status_check check (status in (
    'pending', 'reviewing', 'approved', 'rejected', 'refunded', 'canceled'
  )),
  constraint refund_requests_reason_check check (reason_category in (
    'duplicate_charge', 'not_as_expected', 'accidental_purchase', 'technical_issue', 'other'
  )),
  constraint refund_requests_details_check check (char_length(details) between 10 and 4000),
  constraint refund_requests_tier_check check (tier_snapshot in ('basic', 'pro', 'elite'))
);

create unique index if not exists refund_requests_reference_key
  on public.refund_requests (reference);

-- One live request per purchase. A partial unique index rather than a check,
-- because "one at a time" has to hold against two submissions racing, and only
-- an index decides that.
create unique index if not exists refund_requests_one_active_per_invoice_key
  on public.refund_requests (invoice_ref)
  where invoice_ref is not null and status in ('pending', 'reviewing', 'approved');

create index if not exists refund_requests_user_idx
  on public.refund_requests (user_id, created_at desc);
create index if not exists refund_requests_status_idx
  on public.refund_requests (status, updated_at desc);

alter table public.refund_requests enable row level security;

drop policy if exists "read own or operated refund requests" on public.refund_requests;
create policy "read own or operated refund requests" on public.refund_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin((select auth.uid())));

revoke all on table public.refund_requests from anon, authenticated;
grant select on table public.refund_requests to authenticated;

drop trigger if exists refund_requests_set_updated_at on public.refund_requests;
create trigger refund_requests_set_updated_at
  before update on public.refund_requests
  for each row execute function public.set_operations_updated_at();

-- ---------------------------------------------------------------------------
-- 9. The shared thread, attachments and audit
-- ---------------------------------------------------------------------------
--
-- Tickets and refund requests are two conversations with the same shape, so they
-- share one message table, one attachment index and one audit log. Each row
-- belongs to exactly one of them, which the check below enforces rather than
-- leaves to the caller.
--
-- `is_internal` is the operator's private margin. The reading policy excludes
-- internal rows from everybody who is not an administrator — not the owner of
-- the ticket, not the owner of the refund request — and no routine returns one
-- to a non-operator either. It is enforced twice on purpose: a note that leaks
-- is worse than a note that is never written.
create table if not exists public.support_thread_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  refund_request_id uuid references public.refund_requests(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  author_role text not null,
  body text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint support_thread_messages_subject_check check (
    (ticket_id is not null and refund_request_id is null)
    or (ticket_id is null and refund_request_id is not null)
  ),
  constraint support_thread_messages_role_check check (author_role in ('user', 'admin', 'system')),
  constraint support_thread_messages_body_check check (char_length(body) between 1 and 4000)
);

create index if not exists support_thread_messages_ticket_idx
  on public.support_thread_messages (ticket_id, created_at);
create index if not exists support_thread_messages_refund_idx
  on public.support_thread_messages (refund_request_id, created_at);

alter table public.support_thread_messages enable row level security;

drop policy if exists "read visible thread messages" on public.support_thread_messages;
create policy "read visible thread messages" on public.support_thread_messages
  for select to authenticated
  using (
    public.is_platform_admin((select auth.uid()))
    or (
      is_internal = false
      and (
        exists (
          select 1 from public.support_tickets as ticket
          where ticket.id = support_thread_messages.ticket_id
            and ticket.user_id = (select auth.uid())
        )
        or exists (
          select 1 from public.refund_requests as request
          where request.id = support_thread_messages.refund_request_id
            and request.user_id = (select auth.uid())
        )
      )
    )
  );

revoke all on table public.support_thread_messages from anon, authenticated;
grant select on table public.support_thread_messages to authenticated;

-- The attachment index. The bytes live in a private bucket; this row is the
-- record that they belong to a particular thread, were uploaded by a particular
-- account, and passed the type and size checks. `storage_path` is not a
-- credential — reaching the object still requires a signed URL minted by the
-- server for somebody who owns the thread.
create table if not exists public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  refund_request_id uuid references public.refund_requests(id) on delete cascade,
  message_id uuid references public.support_thread_messages(id) on delete set null,
  uploaded_by uuid references auth.users(id) on delete set null,
  storage_bucket text not null default 'support-attachments',
  storage_path text not null,
  mime_type text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  constraint support_attachments_subject_check check (
    (ticket_id is not null and refund_request_id is null)
    or (ticket_id is null and refund_request_id is not null)
  ),
  -- The allowlist is the validation. A type outside it cannot be recorded even
  -- if an upload somehow reached the bucket, so nothing executable is ever
  -- served back through a signed URL.
  constraint support_attachments_mime_check check (mime_type in (
    'image/png', 'image/jpeg', 'image/webp', 'image/gif'
  )),
  constraint support_attachments_size_check check (size_bytes > 0 and size_bytes <= 5242880)
);

create unique index if not exists support_attachments_path_key
  on public.support_attachments (storage_bucket, storage_path);
create index if not exists support_attachments_ticket_idx
  on public.support_attachments (ticket_id, created_at);
create index if not exists support_attachments_refund_idx
  on public.support_attachments (refund_request_id, created_at);

alter table public.support_attachments enable row level security;

drop policy if exists "read own or operated attachments" on public.support_attachments;
create policy "read own or operated attachments" on public.support_attachments
  for select to authenticated
  using (
    public.is_platform_admin((select auth.uid()))
    or exists (
      select 1 from public.support_tickets as ticket
      where ticket.id = support_attachments.ticket_id
        and ticket.user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.refund_requests as request
      where request.id = support_attachments.refund_request_id
        and request.user_id = (select auth.uid())
    )
  );

revoke all on table public.support_attachments from anon, authenticated;
grant select on table public.support_attachments to authenticated;

-- Append-only. Every state change, every reply and every operator decision on a
-- ticket or a refund request lands here, and the trigger below makes the table
-- refuse to forget any of it.
create table if not exists public.support_audit_events (
  id bigint generated always as identity primary key,
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  refund_request_id uuid references public.refund_requests(id) on delete cascade,
  actor_user_id uuid,
  actor_role text not null,
  action text not null,
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint support_audit_events_role_check check (actor_role in ('user', 'admin', 'system')),
  constraint support_audit_events_action_check check (char_length(action) between 1 and 80)
);

create index if not exists support_audit_events_ticket_idx
  on public.support_audit_events (ticket_id, created_at);
create index if not exists support_audit_events_refund_idx
  on public.support_audit_events (refund_request_id, created_at);

alter table public.support_audit_events enable row level security;
revoke all on table public.support_audit_events from anon, authenticated;

drop trigger if exists support_audit_events_append_only on public.support_audit_events;
create trigger support_audit_events_append_only
  before update or delete on public.support_audit_events
  for each row execute function public.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- 10. What a reader may do
-- ---------------------------------------------------------------------------

-- A short, human-quotable reference. Random rather than sequential, so it
-- discloses neither how many tickets exist nor how many were filed today.
create or replace function public.generate_support_reference(input_prefix text)
returns text
language sql
volatile
set search_path = ''
as $$
  select input_prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
$$;

revoke all on function public.generate_support_reference(text) from public, anon, authenticated;

-- File a ticket.
--
-- The caller sends three fields. The account, the plan they held when they wrote
-- it, the status, the reference and every timestamp are written here. Two rate
-- limits apply — one that stops a double submit becoming two tickets, and one
-- that bounds a day — and both are enforced in the database rather than in a
-- form, because a form is not where an abusive client lives.
create or replace function public.create_support_ticket(
  input_category text,
  input_subject text,
  input_description text
)
returns table (ticket_id uuid, reference text, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  subject_text text := btrim(coalesce(input_subject, ''));
  description_text text := btrim(coalesce(input_description, ''));
  recent_count integer;
  last_created timestamptz;
  new_reference text;
  new_id uuid;
  snapshot_tier text;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if input_category not in (
    'billing', 'subscription', 'portfolio', 'market_data', 'technical', 'suggestion', 'other'
  ) then
    return query select null::uuid, null::text, 'invalid_category'::text;
    return;
  end if;

  if char_length(subject_text) not between 3 and 160
     or char_length(description_text) not between 10 and 4000 then
    return query select null::uuid, null::text, 'invalid_content'::text;
    return;
  end if;

  select count(*), max(ticket.created_at) into recent_count, last_created
  from public.support_tickets as ticket
  where ticket.user_id = requesting_user
    and ticket.created_at > statement_timestamp() - interval '24 hours';

  if last_created is not null
     and last_created > statement_timestamp() - interval '60 seconds' then
    return query select null::uuid, null::text, 'too_soon'::text;
    return;
  end if;

  if recent_count >= 5 then
    return query select null::uuid, null::text, 'rate_limited'::text;
    return;
  end if;

  -- The plan the account actually holds, not what an operator preview is
  -- simulating: a ticket has to record what the reader was paying for.
  snapshot_tier := public.resolve_effective_subscription_tier(
    requesting_user, statement_timestamp()
  );
  new_reference := public.generate_support_reference('TK');

  insert into public.support_tickets (
    reference, user_id, category, subject, description, status, tier_snapshot,
    status_changed_at, created_at, updated_at
  ) values (
    new_reference, requesting_user, input_category, subject_text, description_text,
    'open', snapshot_tier, statement_timestamp(), statement_timestamp(), statement_timestamp()
  )
  returning id into new_id;

  insert into public.support_audit_events (
    ticket_id, actor_user_id, actor_role, action, to_status, detail
  ) values (
    new_id, requesting_user, 'user', 'ticket_created', 'open',
    jsonb_build_object('category', input_category, 'tierSnapshot', snapshot_tier)
  );

  return query select new_id, new_reference, 'created'::text;
end;
$$;

revoke all on function public.create_support_ticket(text, text, text) from public, anon;
grant execute on function public.create_support_ticket(text, text, text) to authenticated;

-- Reply to your own ticket.
--
-- Ownership is resolved from the session, so a crafted ticket id belonging to
-- somebody else finds nothing. A reply to a resolved ticket reopens it, which is
-- what a reader means by writing again; a closed ticket stays closed and the
-- caller is told so rather than silently having their words dropped.
create or replace function public.reply_to_my_support_ticket(
  input_ticket_id uuid,
  input_body text
)
returns table (message_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  body_text text := btrim(coalesce(input_body, ''));
  ticket public.support_tickets%rowtype;
  recent_count integer;
  last_message timestamptz;
  next_status text;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if char_length(body_text) not between 1 and 4000 then
    return query select null::uuid, 'invalid_content'::text;
    return;
  end if;

  select * into ticket
  from public.support_tickets
  where id = input_ticket_id and user_id = requesting_user
  for update;
  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;
  if ticket.status = 'closed' then
    return query select null::uuid, 'closed'::text;
    return;
  end if;

  select count(*), max(message.created_at) into recent_count, last_message
  from public.support_thread_messages as message
  where message.author_user_id = requesting_user
    and message.author_role = 'user'
    and message.created_at > statement_timestamp() - interval '24 hours';
  if last_message is not null
     and last_message > statement_timestamp() - interval '15 seconds' then
    return query select null::uuid, 'too_soon'::text;
    return;
  end if;
  if recent_count >= 40 then
    return query select null::uuid, 'rate_limited'::text;
    return;
  end if;

  insert into public.support_thread_messages (
    ticket_id, author_user_id, author_role, body, is_internal, created_at
  ) values (
    ticket.id, requesting_user, 'user', body_text, false, statement_timestamp()
  )
  returning id into new_id;

  next_status := case when ticket.status in ('waiting_user', 'resolved') then 'open' else ticket.status end;
  update public.support_tickets set
    status = next_status,
    status_changed_at = case when next_status <> ticket.status then statement_timestamp() else status_changed_at end,
    last_user_reply_at = statement_timestamp()
  where id = ticket.id;

  insert into public.support_audit_events (
    ticket_id, actor_user_id, actor_role, action, from_status, to_status, detail
  ) values (
    ticket.id, requesting_user, 'user', 'ticket_user_replied', ticket.status, next_status,
    jsonb_build_object('messageId', new_id)
  );

  return query select new_id, 'replied'::text;
end;
$$;

revoke all on function public.reply_to_my_support_ticket(uuid, text) from public, anon;
grant execute on function public.reply_to_my_support_ticket(uuid, text) to authenticated;

-- The reader's own purchases, sanitized.
--
-- Returns our uuid and money. No invoice identifier, no subscription identifier,
-- no customer identifier, no hosted URL. That is what makes "choose the purchase
-- you want refunded" a safe question to ask a browser: the answer it sends back
-- is meaningless anywhere except against this account's own rows.
create or replace function public.list_my_billing_invoices()
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
    statement_timestamp()
  from public.billing_invoices as invoice
  where invoice.user_id = (select auth.uid())
    and (select auth.uid()) is not null
  order by coalesce(invoice.paid_at, invoice.issued_at, invoice.created_at) desc
  limit 50
$$;

revoke all on function public.list_my_billing_invoices() from public, anon;
grant execute on function public.list_my_billing_invoices() to authenticated;

-- File a refund request.
--
-- The invoice is looked up by our uuid **and** the caller's own id, so pointing
-- at another account's purchase returns `not_found` — it does not reveal that a
-- row exists. Filing grants nothing and withdraws nothing; the status starts at
-- `pending` and only the operator routines below can move it.
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
  if invoice.status not in ('paid', 'partially_refunded') then
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
    jsonb_build_object('reason', input_reason_category, 'tierSnapshot', snapshot_tier)
  );

  return query select new_id, new_reference, 'created'::text;
end;
$$;

revoke all on function public.create_refund_request(uuid, text, text) from public, anon;
grant execute on function public.create_refund_request(uuid, text, text) to authenticated;

-- Withdraw your own request, while it is still undecided.
create or replace function public.cancel_my_refund_request(input_request_id uuid)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  request public.refund_requests%rowtype;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into request
  from public.refund_requests
  where id = input_request_id and user_id = requesting_user
  for update;
  if not found then return 'not_found'; end if;
  if request.status not in ('pending', 'reviewing') then return 'not_cancelable'; end if;

  update public.refund_requests set
    status = 'canceled', status_changed_at = statement_timestamp()
  where id = request.id;

  insert into public.support_audit_events (
    refund_request_id, actor_user_id, actor_role, action, from_status, to_status
  ) values (
    request.id, requesting_user, 'user', 'refund_canceled', request.status, 'canceled'
  );

  return 'canceled';
end;
$$;

revoke all on function public.cancel_my_refund_request(uuid) from public, anon;
grant execute on function public.cancel_my_refund_request(uuid) to authenticated;

-- Reply to your own refund request. Never internal — the flag is not a
-- parameter, so a reader has no way to write into the operator's margin.
create or replace function public.reply_to_my_refund_request(
  input_request_id uuid,
  input_body text
)
returns table (message_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  body_text text := btrim(coalesce(input_body, ''));
  request public.refund_requests%rowtype;
  last_message timestamptz;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if char_length(body_text) not between 1 and 4000 then
    return query select null::uuid, 'invalid_content'::text;
    return;
  end if;

  select * into request
  from public.refund_requests
  where id = input_request_id and user_id = requesting_user;
  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;
  if request.status in ('refunded', 'rejected', 'canceled') then
    return query select null::uuid, 'closed'::text;
    return;
  end if;

  select max(message.created_at) into last_message
  from public.support_thread_messages as message
  where message.author_user_id = requesting_user and message.author_role = 'user';
  if last_message is not null
     and last_message > statement_timestamp() - interval '15 seconds' then
    return query select null::uuid, 'too_soon'::text;
    return;
  end if;

  insert into public.support_thread_messages (
    refund_request_id, author_user_id, author_role, body, is_internal, created_at
  ) values (
    request.id, requesting_user, 'user', body_text, false, statement_timestamp()
  )
  returning id into new_id;

  insert into public.support_audit_events (
    refund_request_id, actor_user_id, actor_role, action, from_status, to_status, detail
  ) values (
    request.id, requesting_user, 'user', 'refund_user_replied', request.status, request.status,
    jsonb_build_object('messageId', new_id)
  );

  return query select new_id, 'replied'::text;
end;
$$;

revoke all on function public.reply_to_my_refund_request(uuid, text) from public, anon;
grant execute on function public.reply_to_my_refund_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. What an operator may do
-- ---------------------------------------------------------------------------
--
-- Every routine below checks `is_platform_admin(auth.uid())` inside the
-- database. None accepts an actor id: the operator is the session, never an
-- argument, so a compromised page cannot act as somebody else's operator.

create or replace function public.admin_reply_support_ticket(
  input_ticket_id uuid,
  input_body text,
  input_internal boolean
)
returns table (message_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  body_text text := btrim(coalesce(input_body, ''));
  internal boolean := coalesce(input_internal, false);
  ticket public.support_tickets%rowtype;
  next_status text;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if char_length(body_text) not between 1 and 4000 then
    return query select null::uuid, 'invalid_content'::text;
    return;
  end if;

  select * into ticket from public.support_tickets where id = input_ticket_id for update;
  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  insert into public.support_thread_messages (
    ticket_id, author_user_id, author_role, body, is_internal, created_at
  ) values (
    ticket.id, requesting_user, 'admin', body_text, internal, statement_timestamp()
  )
  returning id into new_id;

  -- An internal note is not an answer, so it moves nothing the reader can see.
  next_status := case
    when internal then ticket.status
    when ticket.status in ('open', 'in_progress') then 'waiting_user'
    else ticket.status
  end;

  update public.support_tickets set
    status = next_status,
    status_changed_at = case when next_status <> ticket.status then statement_timestamp() else status_changed_at end,
    last_admin_reply_at = case when internal then last_admin_reply_at else statement_timestamp() end
  where id = ticket.id;

  insert into public.support_audit_events (
    ticket_id, actor_user_id, actor_role, action, from_status, to_status, detail
  ) values (
    ticket.id, requesting_user, 'admin',
    case when internal then 'ticket_internal_note' else 'ticket_admin_replied' end,
    ticket.status, next_status,
    jsonb_build_object('messageId', new_id, 'internal', internal)
  );

  return query select new_id, case when internal then 'noted' else 'replied' end;
end;
$$;

revoke all on function public.admin_reply_support_ticket(uuid, text, boolean) from public, anon;
grant execute on function public.admin_reply_support_ticket(uuid, text, boolean) to authenticated;

create or replace function public.admin_set_support_ticket_status(
  input_ticket_id uuid,
  input_status text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  ticket public.support_tickets%rowtype;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if input_status not in ('open', 'in_progress', 'waiting_user', 'resolved', 'closed') then
    return 'invalid_status';
  end if;

  select * into ticket from public.support_tickets where id = input_ticket_id for update;
  if not found then return 'not_found'; end if;
  if ticket.status = input_status then return 'unchanged'; end if;

  update public.support_tickets set
    status = input_status, status_changed_at = statement_timestamp()
  where id = ticket.id;

  insert into public.support_audit_events (
    ticket_id, actor_user_id, actor_role, action, from_status, to_status
  ) values (
    ticket.id, requesting_user, 'admin', 'ticket_status_changed', ticket.status, input_status
  );

  return 'updated';
end;
$$;

revoke all on function public.admin_set_support_ticket_status(uuid, text) from public, anon;
grant execute on function public.admin_set_support_ticket_status(uuid, text) to authenticated;

create or replace function public.admin_reply_refund_request(
  input_request_id uuid,
  input_body text,
  input_internal boolean
)
returns table (message_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  body_text text := btrim(coalesce(input_body, ''));
  internal boolean := coalesce(input_internal, false);
  request public.refund_requests%rowtype;
  new_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if char_length(body_text) not between 1 and 4000 then
    return query select null::uuid, 'invalid_content'::text;
    return;
  end if;

  select * into request from public.refund_requests where id = input_request_id;
  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  insert into public.support_thread_messages (
    refund_request_id, author_user_id, author_role, body, is_internal, created_at
  ) values (
    request.id, requesting_user, 'admin', body_text, internal, statement_timestamp()
  )
  returning id into new_id;

  insert into public.support_audit_events (
    refund_request_id, actor_user_id, actor_role, action, from_status, to_status, detail
  ) values (
    request.id, requesting_user, 'admin',
    case when internal then 'refund_internal_note' else 'refund_admin_replied' end,
    request.status, request.status,
    jsonb_build_object('messageId', new_id, 'internal', internal)
  );

  return query select new_id, case when internal then 'noted' else 'replied' end;
end;
$$;

revoke all on function public.admin_reply_refund_request(uuid, text, boolean) from public, anon;
grant execute on function public.admin_reply_refund_request(uuid, text, boolean) to authenticated;

-- Move a refund request.
--
-- The transitions are a closed graph, and one edge is special: nothing reaches
-- `refunded` from this routine unless the operator supplies a completion
-- reference — the provider's own record of the refund they performed. Approval
-- is a decision; `refunded` is a claim that money moved, and a claim that money
-- moved has to name the evidence. The other way in is
-- `apply_billing_refund_event`, which is reached only from a signed webhook.
--
-- Nothing here touches entitlement. Approving a refund does not revoke access;
-- the refund event does, when the provider confirms it.
create or replace function public.admin_set_refund_request_status(
  input_request_id uuid,
  input_status text,
  input_completion_reference text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  request public.refund_requests%rowtype;
  completion text := nullif(btrim(coalesce(input_completion_reference, '')), '');
  allowed boolean;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if input_status not in ('reviewing', 'approved', 'rejected', 'refunded') then
    return 'invalid_status';
  end if;

  select * into request from public.refund_requests where id = input_request_id for update;
  if not found then return 'not_found'; end if;
  if request.status = input_status then return 'unchanged'; end if;

  allowed := case
    when request.status = 'pending' and input_status in ('reviewing', 'approved', 'rejected') then true
    when request.status = 'reviewing' and input_status in ('approved', 'rejected') then true
    when request.status = 'approved' and input_status in ('refunded', 'rejected') then true
    else false
  end;
  if not allowed then return 'invalid_transition'; end if;

  if input_status = 'refunded' and completion is null then
    return 'confirmation_required';
  end if;

  update public.refund_requests set
    status = input_status,
    status_changed_at = statement_timestamp(),
    decided_at = case when input_status in ('approved', 'rejected') then statement_timestamp() else decided_at end,
    decided_by = case when input_status in ('approved', 'rejected') then requesting_user else decided_by end,
    refunded_at = case when input_status = 'refunded' then statement_timestamp() else refunded_at end
  where id = request.id;

  insert into public.support_audit_events (
    refund_request_id, actor_user_id, actor_role, action, from_status, to_status, detail
  ) values (
    request.id, requesting_user, 'admin', 'refund_status_changed', request.status, input_status,
    case when completion is null then '{}'::jsonb
      else jsonb_build_object('completionReference', completion) end
  );

  return 'updated';
end;
$$;

revoke all on function public.admin_set_refund_request_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_refund_request_status(uuid, text, text) to authenticated;

-- Search accounts, for an operator.
--
-- `security definer` so it can join `auth.users`, which no client role may read.
-- The projection is deliberately narrow and carries no provider identifier: an
-- operator answering a billing question needs a mailbox, a plan, a period and a
-- rail, and none of those is a Stripe id.
create or replace function public.admin_search_accounts(input_query text, input_limit integer)
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  tier text,
  status text,
  effective_tier text,
  billing_plan_key text,
  billing_interval text,
  billing_provider_mode text,
  billing_collection_method text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  access_revoked_at timestamptz,
  access_revoked_reason text,
  open_ticket_count bigint,
  open_refund_count bigint,
  database_now timestamptz
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  needle text := btrim(coalesce(input_query, ''));
  row_limit integer := least(greatest(coalesce(input_limit, 20), 1), 50);
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    account.id,
    account.email,
    profile.full_name,
    coalesce(roles.role, 'user'),
    coalesce(subscription.tier, 'basic'),
    coalesce(subscription.status, 'basic'),
    public.resolve_effective_subscription_tier(account.id, statement_timestamp()),
    subscription.billing_plan_key,
    subscription.billing_interval,
    subscription.billing_provider_mode,
    subscription.billing_collection_method,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end, false),
    subscription.access_revoked_at,
    subscription.access_revoked_reason,
    (select count(*) from public.support_tickets as ticket
      where ticket.user_id = account.id and ticket.status <> 'closed'),
    (select count(*) from public.refund_requests as request
      where request.user_id = account.id
        and request.status in ('pending', 'reviewing', 'approved')),
    statement_timestamp()
  from auth.users as account
  left join public.profiles as profile on profile.id = account.id
  left join public.user_roles as roles on roles.user_id = account.id
  left join public.user_subscriptions as subscription on subscription.user_id = account.id
  where needle <> '' and (
    account.email ilike '%' || needle || '%'
    or profile.full_name ilike '%' || needle || '%'
    or account.id::text = needle
  )
  order by account.created_at desc
  limit row_limit;
end;
$$;

revoke all on function public.admin_search_accounts(text, integer) from public, anon;
grant execute on function public.admin_search_accounts(text, integer) to authenticated;

-- One account's billing history, sanitized for an operator.
--
-- Same rule as the search: money, plans, periods and outcomes — never an
-- identifier that would let this page act on the provider, and never a payment
-- credential, because none is stored.
create or replace function public.admin_account_invoices(input_user_id uuid)
returns table (
  invoice_ref uuid,
  plan_key text,
  status text,
  amount_due_minor bigint,
  amount_paid_minor bigint,
  amount_refunded_minor bigint,
  currency text,
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz
)
language plpgsql
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
    invoice.id, invoice.plan_key, invoice.status,
    invoice.amount_due_minor, invoice.amount_paid_minor, invoice.amount_refunded_minor,
    invoice.currency, invoice.period_start, invoice.period_end,
    invoice.issued_at, invoice.paid_at, invoice.refunded_at, invoice.disputed_at
  from public.billing_invoices as invoice
  where invoice.user_id = input_user_id
  order by coalesce(invoice.paid_at, invoice.issued_at, invoice.created_at) desc
  limit 50;
end;
$$;

revoke all on function public.admin_account_invoices(uuid) from public, anon;
grant execute on function public.admin_account_invoices(uuid) to authenticated;

-- The delivery history for one account, without the provider's event ids. An
-- operator needs to know *what* arrived and how it ended, not the identifier
-- that would let them replay it from a browser.
create or replace function public.admin_account_webhook_history(input_user_id uuid)
returns table (
  event_type text,
  status text,
  provider_mode text,
  error_code text,
  occurred_at timestamptz,
  received_at timestamptz,
  processed_at timestamptz
)
language plpgsql
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
    delivery.event_type, delivery.status, delivery.provider_mode,
    delivery.error_code, delivery.occurred_at, delivery.received_at, delivery.processed_at
  from public.billing_webhook_events as delivery
  where delivery.user_id = input_user_id
  order by delivery.received_at desc
  limit 50;
end;
$$;

revoke all on function public.admin_account_webhook_history(uuid) from public, anon;
grant execute on function public.admin_account_webhook_history(uuid) to authenticated;

-- Open reconciliation issues and dead letters, for the operations page.
create or replace function public.admin_open_billing_issues(input_user_id uuid, input_limit integer)
returns table (
  issue_id uuid,
  issue_type text,
  severity text,
  user_id uuid,
  provider_mode text,
  detail jsonb,
  occurrences integer,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  row_limit integer := least(greatest(coalesce(input_limit, 50), 1), 200);
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    issue.id, issue.issue_type, issue.severity, issue.user_id, issue.provider_mode,
    issue.detail, issue.occurrences, issue.first_seen_at, issue.last_seen_at
  from public.billing_reconciliation_issues as issue
  where issue.resolved_at is null
    and (input_user_id is null or issue.user_id = input_user_id)
  order by
    case issue.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
    issue.last_seen_at desc
  limit row_limit;
end;
$$;

revoke all on function public.admin_open_billing_issues(uuid, integer) from public, anon;
grant execute on function public.admin_open_billing_issues(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. What the server may do
-- ---------------------------------------------------------------------------
--
-- Service-role only. None of these is granted to `anon` or `authenticated`, so
-- a client holding a valid session cannot reach any of them at all.

-- Record what the provider billed. Upsert, because an invoice is issued, then
-- paid, then possibly refunded, and each of those arrives as its own delivery.
create or replace function public.record_billing_invoice(
  input_user_id uuid,
  input_provider text,
  input_provider_mode text,
  input_invoice_id text,
  input_subscription_id text,
  input_plan_key text,
  input_status text,
  input_amount_due_minor bigint,
  input_amount_paid_minor bigint,
  input_currency text,
  input_period_start timestamptz,
  input_period_end timestamptz,
  input_issued_at timestamptz,
  input_paid_at timestamptz
)
returns text
language plpgsql
security definer set search_path = ''
as $$
begin
  if input_user_id is null
     or input_invoice_id is null
     or input_provider_mode not in ('test', 'live')
     or input_status not in ('open', 'paid', 'void', 'uncollectible') then
    return 'ignored';
  end if;
  if not exists (select 1 from auth.users as account where account.id = input_user_id) then
    return 'unknown_user';
  end if;

  insert into public.billing_invoices as target (
    user_id, provider, provider_mode, invoice_id, subscription_id, plan_key, status,
    amount_due_minor, amount_paid_minor, currency,
    period_start, period_end, issued_at, paid_at, created_at, updated_at
  ) values (
    input_user_id, coalesce(input_provider, 'stripe'), input_provider_mode, input_invoice_id,
    input_subscription_id, input_plan_key, input_status,
    greatest(coalesce(input_amount_due_minor, 0), 0),
    greatest(coalesce(input_amount_paid_minor, 0), 0),
    lower(coalesce(input_currency, 'thb')),
    input_period_start, input_period_end,
    coalesce(input_issued_at, statement_timestamp()), input_paid_at,
    statement_timestamp(), statement_timestamp()
  )
  on conflict (provider, provider_mode, invoice_id) do update set
    subscription_id = coalesce(excluded.subscription_id, target.subscription_id),
    plan_key = coalesce(excluded.plan_key, target.plan_key),
    -- A refunded or disputed invoice is not walked back to `paid` by a
    -- redelivery of the payment that preceded it. Those two states are written
    -- by the refund routine and only it may leave them.
    status = case
      when target.status in ('refunded', 'partially_refunded', 'disputed') then target.status
      else excluded.status
    end,
    amount_due_minor = greatest(excluded.amount_due_minor, target.amount_due_minor),
    amount_paid_minor = greatest(excluded.amount_paid_minor, target.amount_paid_minor),
    currency = excluded.currency,
    period_start = coalesce(excluded.period_start, target.period_start),
    period_end = coalesce(excluded.period_end, target.period_end),
    issued_at = least(coalesce(excluded.issued_at, target.issued_at), target.issued_at),
    paid_at = coalesce(target.paid_at, excluded.paid_at),
    updated_at = statement_timestamp();

  return 'recorded';
end;
$$;

revoke all on function public.record_billing_invoice(
  uuid, text, text, text, text, text, text, bigint, bigint, text,
  timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_billing_invoice(
  uuid, text, text, text, text, text, text, bigint, bigint, text,
  timestamptz, timestamptz, timestamptz, timestamptz
) to service_role;

-- Apply a provider-confirmed refund, dispute or dispute resolution.
--
-- Idempotent on the provider's event id, which is claimed here in the refund
-- ledger — a redelivery loses that insert and changes nothing. The entitlement
-- consequence is decided by `input_action`, computed by the pure classifier in
-- the application and constrained to the four values above.
create or replace function public.apply_billing_refund_event(
  input_provider text,
  input_provider_mode text,
  input_event_id text,
  input_event_type text,
  input_kind text,
  input_action text,
  input_occurred_at timestamptz,
  input_user_id uuid,
  input_subscription_id text,
  input_invoice_id text,
  input_charge_id text,
  input_amount_minor bigint,
  input_charge_amount_minor bigint,
  input_currency text,
  input_is_full boolean,
  input_dispute_outcome text
)
returns table (outcome text, entitlement_changed boolean, refund_event_id uuid)
language plpgsql
security definer set search_path = ''
as $$
declare
  claimed_id uuid;
  existing public.user_subscriptions%rowtype;
  matched_invoice uuid;
  changed boolean := false;
  result text := 'recorded';
  restore_to text;
begin
  if input_provider is null
     or input_provider_mode not in ('test', 'live')
     or input_event_id is null
     or input_kind not in ('refund', 'dispute_opened', 'dispute_closed')
     or input_action not in ('revoke', 'suspend', 'restore', 'record_only') then
    raise exception 'BILLING_REFUND_EVENT_INCOMPLETE' using errcode = 'P0001';
  end if;

  insert into public.billing_refund_events (
    provider, provider_mode, provider_event_id, event_type, kind, entitlement_action,
    user_id, subscription_id, invoice_id, charge_id, amount_minor, charge_amount_minor,
    currency, is_full, dispute_outcome, occurred_at
  ) values (
    input_provider, input_provider_mode, input_event_id, input_event_type, input_kind, input_action,
    input_user_id, input_subscription_id, input_invoice_id, input_charge_id,
    greatest(coalesce(input_amount_minor, 0), 0), input_charge_amount_minor,
    lower(coalesce(input_currency, 'thb')), coalesce(input_is_full, false),
    input_dispute_outcome, coalesce(input_occurred_at, statement_timestamp())
  )
  on conflict (provider, provider_mode, provider_event_id) do nothing
  returning id into claimed_id;

  if claimed_id is null then
    return query select 'duplicate'::text, false, null::uuid;
    return;
  end if;

  if input_user_id is null then
    update public.billing_refund_events set outcome = 'unknown_user' where id = claimed_id;
    return query select 'unknown_user'::text, false, claimed_id;
    return;
  end if;

  select * into existing
  from public.user_subscriptions where user_id = input_user_id for update;
  if not found then
    update public.billing_refund_events set outcome = 'unknown_user' where id = claimed_id;
    return query select 'unknown_user'::text, false, claimed_id;
    return;
  end if;

  -- The invoice ledger is updated whatever the entitlement consequence: a
  -- partial refund that changes no access still changes what was collected.
  if input_invoice_id is not null then
    select ledger.id into matched_invoice
    from public.billing_invoices as ledger
    where ledger.provider = input_provider
      and ledger.provider_mode = input_provider_mode
      and ledger.invoice_id = input_invoice_id
    for update;

    if matched_invoice is not null then
      update public.billing_invoices set
        amount_refunded_minor = case
          when input_kind = 'refund'
            then greatest(amount_refunded_minor, greatest(coalesce(input_amount_minor, 0), 0))
          else amount_refunded_minor
        end,
        status = case
          when input_kind = 'dispute_opened' then 'disputed'
          when input_kind = 'refund' and coalesce(input_is_full, false) then 'refunded'
          when input_kind = 'refund' then 'partially_refunded'
          when input_kind = 'dispute_closed' and input_dispute_outcome = 'won' then 'paid'
          when input_kind = 'dispute_closed' then 'refunded'
          else status
        end,
        refunded_at = case
          when input_kind = 'refund' then coalesce(refunded_at, input_occurred_at)
          else refunded_at
        end,
        disputed_at = case
          when input_kind = 'dispute_opened' then coalesce(disputed_at, input_occurred_at)
          else disputed_at
        end
      where id = matched_invoice;
    end if;
  end if;

  -- An event naming a subscription this account is not on changes no access. It
  -- is still recorded above, which is the point of a ledger.
  if input_subscription_id is not null
     and existing.billing_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id then
    update public.billing_refund_events
      set outcome = 'subscription_mismatch' where id = claimed_id;
    return query select 'subscription_mismatch'::text, false, claimed_id;
    return;
  end if;

  if input_action in ('revoke', 'suspend') then
    if existing.status in ('active', 'past_due') then
      update public.user_subscriptions set
        status = 'expired',
        access_revoked_at = coalesce(input_occurred_at, statement_timestamp()),
        access_revoked_reason = case when input_kind = 'refund' then 'refund' else 'dispute' end,
        -- Only a suspension is meant to come back, so only a suspension records
        -- what to come back to.
        access_revoked_restore_status = case
          when input_action = 'suspend' then existing.status
          else null
        end
      where user_id = input_user_id;
      changed := true;
      result := case when input_action = 'suspend' then 'suspended' else 'revoked' end;
    else
      result := 'no_active_entitlement';
    end if;

  elsif input_action = 'restore' then
    restore_to := existing.access_revoked_restore_status;
    if existing.access_revoked_at is not null
       and existing.access_revoked_reason = 'dispute'
       and restore_to in ('active', 'past_due')
       and existing.current_period_end is not null
       and existing.current_period_end > statement_timestamp() then
      update public.user_subscriptions set
        status = restore_to,
        access_revoked_at = null,
        access_revoked_reason = null,
        access_revoked_restore_status = null
      where user_id = input_user_id;
      changed := true;
      result := 'restored';
    else
      -- Nothing to restore, or the period it belonged to has since run out.
      -- Clearing the flag without granting keeps the row honest.
      if existing.access_revoked_reason = 'dispute' then
        update public.user_subscriptions set
          access_revoked_restore_status = null
        where user_id = input_user_id;
      end if;
      result := 'not_restorable';
    end if;
  end if;

  -- A provider-confirmed full refund closes an open request for the same
  -- purchase. This is the trusted path to `refunded`: money actually moved, and
  -- the provider said so.
  if input_kind = 'refund' and coalesce(input_is_full, false) and matched_invoice is not null then
    update public.refund_requests set
      status = 'refunded',
      status_changed_at = statement_timestamp(),
      refunded_at = coalesce(input_occurred_at, statement_timestamp()),
      refund_event_id = claimed_id
    where invoice_ref = matched_invoice
      and status in ('pending', 'reviewing', 'approved');

    insert into public.support_audit_events (
      refund_request_id, actor_user_id, actor_role, action, to_status, detail
    )
    select request.id, null, 'system', 'refund_confirmed_by_provider', 'refunded',
      jsonb_build_object('refundEventId', claimed_id)
    from public.refund_requests as request
    where request.invoice_ref = matched_invoice
      and request.status = 'refunded'
      and request.refund_event_id = claimed_id;
  end if;

  update public.billing_refund_events
    set outcome = result, entitlement_changed = changed
  where id = claimed_id;

  return query select result, changed, claimed_id;
end;
$$;

revoke all on function public.apply_billing_refund_event(
  text, text, text, text, text, text, timestamptz, uuid, text, text, text,
  bigint, bigint, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.apply_billing_refund_event(
  text, text, text, text, text, text, timestamptz, uuid, text, text, text,
  bigint, bigint, text, boolean, text
) to service_role;

-- Record one failed delivery and say whether it has run out of attempts.
create or replace function public.record_billing_webhook_attempt(
  input_provider text,
  input_provider_mode text,
  input_event_id text,
  input_event_type text,
  input_user_id uuid,
  input_error_code text,
  input_backoff_seconds integer,
  input_max_attempts integer
)
returns table (attempt_count integer, status text, next_attempt_at timestamptz, newly_dead_lettered boolean)
language plpgsql
security definer set search_path = ''
as $$
declare
  row_record public.billing_webhook_retries%rowtype;
  bound integer := greatest(coalesce(input_max_attempts, 8), 1);
  backoff integer := greatest(coalesce(input_backoff_seconds, 60), 1);
  was_dead_letter boolean := false;
begin
  if input_provider is null
     or input_provider_mode not in ('test', 'live')
     or input_event_id is null then
    raise exception 'BILLING_RETRY_INCOMPLETE' using errcode = 'P0001';
  end if;

  insert into public.billing_webhook_retries as target (
    provider, provider_mode, provider_event_id, event_type, user_id,
    attempt_count, status, last_error_code,
    first_failed_at, last_failed_at, next_attempt_at
  ) values (
    input_provider, input_provider_mode, input_event_id, coalesce(input_event_type, 'unknown'),
    input_user_id, 1, 'retrying', input_error_code,
    statement_timestamp(), statement_timestamp(),
    statement_timestamp() + make_interval(secs => backoff)
  )
  on conflict (provider, provider_mode, provider_event_id) do update set
    attempt_count = target.attempt_count + 1,
    event_type = coalesce(excluded.event_type, target.event_type),
    user_id = coalesce(excluded.user_id, target.user_id),
    last_error_code = excluded.last_error_code,
    last_failed_at = statement_timestamp(),
    next_attempt_at = statement_timestamp() + make_interval(secs => backoff),
    status = case when target.status = 'dead_letter' then 'dead_letter' else 'retrying' end
  returning * into row_record;

  was_dead_letter := row_record.status = 'dead_letter';

  if not was_dead_letter and row_record.attempt_count >= bound then
    update public.billing_webhook_retries set
      status = 'dead_letter', dead_lettered_at = statement_timestamp()
    where id = row_record.id
    returning * into row_record;
    return query select row_record.attempt_count, row_record.status, row_record.next_attempt_at, true;
    return;
  end if;

  return query select row_record.attempt_count, row_record.status, row_record.next_attempt_at, false;
end;
$$;

revoke all on function public.record_billing_webhook_attempt(
  text, text, text, text, uuid, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.record_billing_webhook_attempt(
  text, text, text, text, uuid, text, integer, integer
) to service_role;

-- A later delivery succeeded. The failure history stays; the row stops being an
-- open problem.
create or replace function public.resolve_billing_webhook_retry(
  input_provider text,
  input_provider_mode text,
  input_event_id text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer;
begin
  update public.billing_webhook_retries set
    status = 'resolved', resolved_at = statement_timestamp()
  where provider = input_provider
    and provider_mode = input_provider_mode
    and provider_event_id = input_event_id
    and status <> 'resolved';
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.resolve_billing_webhook_retry(text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_billing_webhook_retry(text, text, text)
  to service_role;

-- Mark that operators have been told about a dead letter, so they are told once.
create or replace function public.mark_billing_webhook_alerted(
  input_provider text,
  input_provider_mode text,
  input_event_id text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer;
begin
  update public.billing_webhook_retries set alerted_at = statement_timestamp()
  where provider = input_provider
    and provider_mode = input_provider_mode
    and provider_event_id = input_event_id
    and alerted_at is null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.mark_billing_webhook_alerted(text, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_billing_webhook_alerted(text, text, text)
  to service_role;

-- Start the day's reconciliation. One run per day per provider mode; a second
-- caller on the same day loses the unique index and is told the run is taken.
create or replace function public.start_billing_reconciliation_run(
  input_local_date date,
  input_provider_mode text
)
returns table (run_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  claimed uuid;
  existing public.billing_reconciliation_runs%rowtype;
begin
  if input_provider_mode not in ('test', 'live') then
    raise exception 'BILLING_RECONCILIATION_MODE_REQUIRED' using errcode = 'P0001';
  end if;

  insert into public.billing_reconciliation_runs (local_date, provider_mode, status, started_at)
  values (input_local_date, input_provider_mode, 'running', statement_timestamp())
  on conflict (local_date, provider_mode) do nothing
  returning id into claimed;

  if claimed is not null then
    return query select claimed, 'started'::text;
    return;
  end if;

  select * into existing from public.billing_reconciliation_runs
  where local_date = input_local_date and provider_mode = input_provider_mode;

  -- A run that failed may be picked up again the same day; one that completed
  -- may not, which is what makes this a daily job rather than a per-tick one.
  if existing.status = 'failed' then
    update public.billing_reconciliation_runs set
      status = 'running', started_at = statement_timestamp(),
      completed_at = null, error_code = null
    where id = existing.id;
    return query select existing.id, 'resumed'::text;
    return;
  end if;

  return query select existing.id, 'already_ran'::text;
end;
$$;

revoke all on function public.start_billing_reconciliation_run(date, text)
  from public, anon, authenticated;
grant execute on function public.start_billing_reconciliation_run(date, text)
  to service_role;

-- Report one disagreement. Deduplicated by a stable key: the same condition on
-- the same account on ten consecutive days is one row with `occurrences` at ten.
create or replace function public.record_billing_reconciliation_issue(
  input_run_id uuid,
  input_dedupe_key text,
  input_issue_type text,
  input_severity text,
  input_user_id uuid,
  input_provider_mode text,
  input_detail jsonb
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  was_new boolean;
begin
  if input_dedupe_key is null or input_issue_type is null then
    raise exception 'BILLING_ISSUE_INCOMPLETE' using errcode = 'P0001';
  end if;

  insert into public.billing_reconciliation_issues as target (
    dedupe_key, issue_type, severity, user_id, provider_mode, detail,
    occurrences, first_seen_at, last_seen_at, last_run_id
  ) values (
    input_dedupe_key, input_issue_type, coalesce(input_severity, 'warning'),
    input_user_id, input_provider_mode, coalesce(input_detail, '{}'::jsonb),
    1, statement_timestamp(), statement_timestamp(), input_run_id
  )
  on conflict (dedupe_key) do update set
    occurrences = target.occurrences + 1,
    severity = coalesce(excluded.severity, target.severity),
    detail = coalesce(excluded.detail, target.detail),
    last_seen_at = statement_timestamp(),
    last_run_id = excluded.last_run_id,
    -- A condition that has come back is open again.
    resolved_at = null
  -- `xmax = 0` on the returned row is Postgres' own answer to "was this an
  -- insert or an update?", which is the only reliable one for an upsert.
  returning (xmax = 0) into was_new;

  return case when was_new then 'recorded' else 'updated' end;
end;
$$;

revoke all on function public.record_billing_reconciliation_issue(
  uuid, text, text, text, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_billing_reconciliation_issue(
  uuid, text, text, text, uuid, text, jsonb
) to service_role;

-- Anything the run did not see again this pass has stopped happening.
create or replace function public.complete_billing_reconciliation_run(
  input_run_id uuid,
  input_checked integer,
  input_issue_count integer,
  input_status text,
  input_error_code text
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  resolved integer := 0;
  run_mode text;
begin
  if input_status not in ('completed', 'failed') then
    raise exception 'BILLING_RECONCILIATION_STATUS_INVALID' using errcode = 'P0001';
  end if;

  update public.billing_reconciliation_runs set
    status = input_status,
    checked_count = greatest(coalesce(input_checked, 0), 0),
    issue_count = greatest(coalesce(input_issue_count, 0), 0),
    completed_at = statement_timestamp(),
    error_code = input_error_code
  where id = input_run_id
  returning provider_mode into run_mode;

  -- A run that finished saw everything it was going to see, so an issue it did
  -- not re-report has stopped happening and is closed. Scoped to the mode this
  -- run covered: a test-mode pass must never close a live-mode issue.
  if input_status = 'completed' and run_mode is not null then
    update public.billing_reconciliation_issues set resolved_at = statement_timestamp()
    where resolved_at is null
      and provider_mode is not distinct from run_mode
      and last_run_id is distinct from input_run_id;
    get diagnostics resolved = row_count;
  end if;

  return resolved;
end;
$$;

revoke all on function public.complete_billing_reconciliation_run(uuid, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_billing_reconciliation_run(uuid, integer, integer, text, text)
  to service_role;

-- Record an attachment the server has already validated and stored. Service
-- role, because the upload itself runs on the server: the browser never holds a
-- storage credential, and the type and size are checked before a byte is
-- written as well as by the constraints above.
create or replace function public.record_support_attachment(
  input_ticket_id uuid,
  input_refund_request_id uuid,
  input_uploaded_by uuid,
  input_storage_bucket text,
  input_storage_path text,
  input_mime_type text,
  input_size_bytes integer
)
returns table (attachment_id uuid, outcome text)
language plpgsql
security definer set search_path = ''
as $$
declare
  new_id uuid;
begin
  if (input_ticket_id is null) = (input_refund_request_id is null) then
    return query select null::uuid, 'invalid_subject'::text;
    return;
  end if;
  if input_mime_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
     or input_size_bytes is null
     or input_size_bytes <= 0
     or input_size_bytes > 5242880 then
    return query select null::uuid, 'invalid_file'::text;
    return;
  end if;

  -- The uploader must own the thread. Checked here as well as in the action, so
  -- a bug in one cannot attach a file to somebody else's ticket.
  if input_ticket_id is not null and not exists (
    select 1 from public.support_tickets as ticket
    where ticket.id = input_ticket_id and ticket.user_id = input_uploaded_by
  ) then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;
  if input_refund_request_id is not null and not exists (
    select 1 from public.refund_requests as request
    where request.id = input_refund_request_id and request.user_id = input_uploaded_by
  ) then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  insert into public.support_attachments (
    ticket_id, refund_request_id, uploaded_by, storage_bucket, storage_path,
    mime_type, size_bytes
  ) values (
    input_ticket_id, input_refund_request_id, input_uploaded_by,
    coalesce(input_storage_bucket, 'support-attachments'), input_storage_path,
    input_mime_type, input_size_bytes
  )
  returning id into new_id;

  insert into public.support_audit_events (
    ticket_id, refund_request_id, actor_user_id, actor_role, action, detail
  ) values (
    input_ticket_id, input_refund_request_id, input_uploaded_by, 'user', 'attachment_added',
    jsonb_build_object('attachmentId', new_id, 'mimeType', input_mime_type, 'sizeBytes', input_size_bytes)
  );

  return query select new_id, 'recorded'::text;
end;
$$;

revoke all on function public.record_support_attachment(
  uuid, uuid, uuid, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.record_support_attachment(
  uuid, uuid, uuid, text, text, text, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- 13. The revocation hold
-- ---------------------------------------------------------------------------
--
-- `apply_billing_subscription_event`, unchanged from Phase 4.4 except for one
-- rule and its two supporting lines.
--
-- The problem it solves: a full refund or a lost chargeback sets the status to
-- `expired`, but the provider does not consider the subscription over — a
-- routine `customer.subscription.updated` arriving an hour later would assert
-- `active` again and hand the access straight back. So while a revocation is
-- recorded, an event for the *same* subscription may not assert a granting
-- status.
--
-- The one thing that lifts it is money: a paid invoice covering a period that
-- ends after the revocation clears the flag and applies normally. A new
-- subscription clears it too, because it is a different purchase. Everything
-- else is held, recorded and answered 200 — the delivery was understood, it just
-- did not move anybody's access.
create or replace function public.apply_billing_subscription_event(
  input_provider text,
  input_provider_mode text,
  input_event_id text,
  input_event_type text,
  input_occurred_at timestamptz,
  input_payload_digest text,
  input_user_id uuid,
  input_customer_id text,
  input_subscription_id text,
  input_plan_key text,
  input_price_id text,
  input_tier text,
  input_status text,
  input_interval text,
  input_period_start timestamptz,
  input_period_end timestamptz,
  input_cancel_at_period_end boolean,
  input_invoice_id text,
  input_payment_status text,
  input_founder boolean
)
returns table (outcome text, applied_user_id uuid)
language plpgsql
security definer set search_path = ''
as $$
declare
  claimed_id bigint;
  existing public.user_subscriptions%rowtype;
  same_provider_identity boolean;
  stored_subscription_live boolean;
  same_subscription boolean;
  payment_clears_revocation boolean;
  failure text;
begin
  if input_provider is null
     or input_provider_mode not in ('test', 'live')
     or input_event_id is null
     or input_event_type is null then
    raise exception 'BILLING_EVENT_INCOMPLETE' using errcode = 'P0001';
  end if;

  insert into public.billing_webhook_events (
    provider, provider_mode, provider_event_id, event_type, status,
    user_id, occurred_at, payload_digest
  ) values (
    input_provider, input_provider_mode, input_event_id, input_event_type,
    'received', input_user_id, input_occurred_at, input_payload_digest
  )
  on conflict (provider, provider_mode, provider_event_id) do nothing
  returning id into claimed_id;

  if claimed_id is null then
    return query select 'duplicate'::text, input_user_id;
    return;
  end if;

  if input_user_id is null or input_status is null then
    update public.billing_webhook_events
      set status = 'ignored', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'ignored'::text, input_user_id;
    return;
  end if;

  if input_customer_id is null or input_subscription_id is null then
    update public.billing_webhook_events
      set status = 'failed', error_code = 'identity_incomplete', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'identity_incomplete'::text, input_user_id;
    return;
  end if;

  select * into existing
  from public.user_subscriptions
  where user_id = input_user_id
  for update;

  if not found then
    update public.billing_webhook_events
      set status = 'failed', error_code = 'unknown_user', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'unknown_user'::text, input_user_id;
    return;
  end if;

  same_provider_identity := existing.billing_provider = input_provider
    and existing.billing_provider_mode = input_provider_mode;

  stored_subscription_live := existing.status in ('active', 'past_due')
    and (existing.billing_collection_method is distinct from 'send_invoice'
         or (existing.current_period_end is not null
             and existing.current_period_end > statement_timestamp()));

  failure := null;
  if existing.billing_provider = input_provider
     and existing.billing_provider_mode = 'live'
     and input_provider_mode = 'test' then
    failure := 'provider_mode_downgrade';
  elsif same_provider_identity
     and existing.billing_customer_id is not null
     and existing.billing_customer_id <> input_customer_id then
    failure := 'customer_mismatch';
  elsif same_provider_identity
     and existing.billing_subscription_id is not null
     and existing.billing_subscription_id <> input_subscription_id
     and stored_subscription_live then
    failure := 'subscription_mismatch';
  end if;

  if failure is not null then
    update public.billing_webhook_events
      set status = 'failed', error_code = failure, processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select failure, input_user_id;
    return;
  end if;

  if same_provider_identity
     and existing.billing_subscription_id is not distinct from input_subscription_id
     and existing.provider_event_at is not null
     and input_occurred_at is not null
     and input_occurred_at < existing.provider_event_at then
    update public.billing_webhook_events
      set status = 'stale', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'stale'::text, input_user_id;
    return;
  end if;

  same_subscription := existing.billing_subscription_id is not distinct from input_subscription_id;
  /*
   * `coalesce` around the whole expression, and it is load-bearing.
   *
   * `input_payment_status` is NULL on every event that is not an invoice —
   * including `customer.subscription.updated`, which is exactly the event that
   * would otherwise hand access back an hour after a refund. Without the
   * coalesce this is NULL rather than false, `not NULL` is NULL, and the guard
   * below silently does not fire.
   */
  payment_clears_revocation := coalesce(
    input_payment_status = 'succeeded'
      and input_period_end is not null
      and existing.access_revoked_at is not null
      and input_period_end > existing.access_revoked_at,
    false
  );

  if existing.access_revoked_at is not null
     and same_subscription
     and input_status in ('active', 'past_due')
     and not payment_clears_revocation then
    update public.billing_webhook_events
      set status = 'ignored', error_code = 'access_revoked_hold', processed_at = statement_timestamp()
      where id = claimed_id
        and provider = input_provider
        and provider_mode = input_provider_mode
        and provider_event_id = input_event_id;
    return query select 'revoked_hold'::text, input_user_id;
    return;
  end if;

  update public.user_subscriptions
  set
    tier = case when same_provider_identity then coalesce(input_tier, tier) else input_tier end,
    status = input_status,
    billing_provider = input_provider,
    billing_provider_mode = input_provider_mode,
    billing_plan_key = case when same_provider_identity then coalesce(input_plan_key, billing_plan_key) else input_plan_key end,
    billing_interval = case when same_provider_identity then coalesce(input_interval, billing_interval) else input_interval end,
    billing_customer_id = case when same_provider_identity then coalesce(input_customer_id, billing_customer_id) else input_customer_id end,
    billing_subscription_id = case when same_provider_identity then coalesce(input_subscription_id, billing_subscription_id) else input_subscription_id end,
    billing_price_id = case when same_provider_identity then coalesce(input_price_id, billing_price_id) else input_price_id end,
    billing_collection_method = case
      when existing.billing_subscription_id is distinct from input_subscription_id then null
      else billing_collection_method
    end,
    current_period_start = case
      when not same_provider_identity
        or existing.billing_subscription_id is distinct from input_subscription_id
        then input_period_start
      else coalesce(input_period_start, current_period_start)
    end,
    current_period_end = case
      when not same_provider_identity
        or existing.billing_subscription_id is distinct from input_subscription_id
        then input_period_end
      else coalesce(input_period_end, current_period_end)
    end,
    cancel_at_period_end = case when same_provider_identity then coalesce(input_cancel_at_period_end, cancel_at_period_end) else coalesce(input_cancel_at_period_end, false) end,
    latest_invoice_id = case when same_provider_identity then coalesce(input_invoice_id, latest_invoice_id) else input_invoice_id end,
    latest_payment_status = case when same_provider_identity then coalesce(input_payment_status, latest_payment_status) else input_payment_status end,
    latest_payment_at = case
      when input_payment_status is not null then statement_timestamp()
      when same_provider_identity then latest_payment_at
      else null
    end,
    founder_promo_applied = case
      when same_provider_identity then founder_promo_applied or coalesce(input_founder, false)
      else coalesce(input_founder, false)
    end,
    -- Money, or a different purchase entirely, is what lifts a revocation.
    access_revoked_at = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_at
    end,
    access_revoked_reason = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_reason
    end,
    access_revoked_restore_status = case
      when payment_clears_revocation or not same_subscription then null
      else access_revoked_restore_status
    end,
    provider_event_at = input_occurred_at,
    provider_event_id = input_event_id
  where user_id = input_user_id;

  update public.billing_webhook_events
    set status = 'applied', processed_at = statement_timestamp()
    where id = claimed_id
      and provider = input_provider
      and provider_mode = input_provider_mode
      and provider_event_id = input_event_id;

  return query select 'applied'::text, input_user_id;
end;
$$;

revoke all on function public.apply_billing_subscription_event(
  text, text, text, text, timestamptz, text, uuid, text, text, text, text, text,
  text, text, timestamptz, timestamptz, boolean, text, text, boolean
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 14. The private attachment bucket
-- ---------------------------------------------------------------------------
--
-- Guarded, because the `storage` schema only exists on a Supabase database —
-- the migration is also executed against a bare Postgres in tests, and it has to
-- run there too.
--
-- `public = false` is the whole point: nothing in this bucket is reachable by
-- URL. Objects are written by the server with the service role after the type
-- and size have been checked, and read back only through a signed URL minted for
-- somebody who owns the thread. No policy is created for `anon` or
-- `authenticated`, so neither role can list, read, write or delete an object.
do $$
begin
  if exists (
    select 1
    from pg_class as relation
    join pg_namespace as schema_entry on schema_entry.oid = relation.relnamespace
    where schema_entry.nspname = 'storage' and relation.relname = 'buckets'
  ) then
    -- Dynamic, so the statement is never parsed on a database that has no
    -- `storage` schema to parse it against.
    execute $bucket$
      insert into storage.buckets (id, name, public)
      values ('support-attachments', 'support-attachments', false)
      on conflict (id) do update set public = false
    $bucket$;
  end if;
end;
$$;

commit;
