begin;

-- ===========================================================================
-- Overview alert rules — the reader's own thresholds, checked on a page read
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence: `overview_alert_rules` resolves `id`, `user_id`, `symbol`, `kind`,
-- `threshold`, `enabled`, `created_at`, `updated_at` — read from the endpoint's
-- own OpenAPI definition, which reports the live column set rather than this
-- file's text. NOT covered: `overview_alert_rules_owner_symbol_kind_key`, the
-- partial index, the four RLS policies, the CHECK constraints, and
-- `create_overview_alert_rule` — PostgREST reports relations and columns and
-- nothing else. See `docs/operations/migration-state.md`.
--
-- Applied together with `202608310001` and `202608310002`, in that order. The
-- queue this file used to head is empty; there are no unapplied migrations.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT A SECOND `price_alerts`
-- ---------------------------------------------------------------------------
-- `public.price_alerts` already exists and already stores four conditions. It
-- is NOT reused, and the difference is not cosmetic — it is the whole of what
-- makes that table correct:
--
--     cooldown_minutes / last_triggered_at / last_evaluated_at
--
-- Those three columns exist because that system is SCHEDULED. `/api/cron/alerts`
-- evaluates it on a timer, writes a notification row and pushes to a device, so
-- it must remember what it has already said or it wakes somebody twice at 3 a.m.
--
-- This table backs a section on a page. A rule is checked when a reader loads
-- the overview, a match is a line on the screen, and nothing is written, queued
-- or sent. There is no "already told you", so there is nothing to cool down —
-- and adding these rows to `price_alerts` would silently enroll every one of
-- them in the notification sweep, which is precisely the behaviour this feature
-- does not have. Two tables is the honest way to say that the two things are
-- different.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
-- ---------------------------------------------------------------------------
-- No `last_triggered_at`, no hit table, no notification. A hit is derived at
-- read time by `src/lib/market-overview/alerts/evaluate.ts` and lives as long as
-- the render does. Persisting hits would mean writing on a GET, which turns
-- every page load into a transaction and every cached render into a lie.
--
-- No cron entry. `vercel.json` is untouched by this change.
create table if not exists public.overview_alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  /*
    The same symbol shape every other symbol column in this schema uses, so a
    rule cannot arrive in a form that fails to join with the page's quote map.
    The leading-caret branch admits the index instruments (`^VIX`, `^TNX`) the
    overview already quotes.
  */
  symbol text not null check (
    symbol = upper(trim(symbol))
    and char_length(symbol) between 1 and 20
    and symbol ~ '^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]*)$'
  ),
  /*
    Four kinds, constrained rather than free text.

    They are the same four comparisons `price_alerts.condition` makes, under
    this feature's own names. The names differ on purpose: a shared vocabulary
    across two tables invites a query that reads rows from one and hands them to
    the other's evaluator, and the two evaluators have different contracts about
    what happens after a match.
  */
  kind text not null check (kind in ('price_above', 'price_below', 'percent_up', 'percent_down')),
  /*
    ALWAYS POSITIVE, including for `percent_down`.

    The direction is carried by `kind`; the threshold is a magnitude. Storing
    -5 for "down 5%" would compare a negative threshold against a negative
    change, and the first person to write the obvious `<=` would invert the
    rule with nothing to catch it. `numeric` and not `double precision`, matching
    `price_alerts.target_value`: a threshold a reader typed is an exact decimal
    and must read back as the one they typed.
  */
  threshold numeric not null check (threshold > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
  One rule per symbol per kind, per reader.

  Two "SPY above 600" rules are not two alerts, they are one alert drawn twice —
  and the section would print the same line twice with no way for the reader to
  tell which of them to delete. A reader who wants two levels on one symbol
  writes one `price_above` and one `price_below`, which this permits.
*/
create unique index if not exists overview_alert_rules_owner_symbol_kind_key
  on public.overview_alert_rules (user_id, symbol, kind);

/*
  The read the page actually performs: this reader's enabled rules. Partial on
  `enabled` because a disabled rule is never evaluated and does not belong in
  the index the hot path walks.
*/
create index if not exists overview_alert_rules_owner_enabled_idx
  on public.overview_alert_rules (user_id, symbol)
  where enabled;

-- ---------------------------------------------------------------------------
-- How many rules one account may have
-- ---------------------------------------------------------------------------
--
-- A cap exists because "create" with no ceiling is an unbounded write loop
-- behind one authenticated session, and every rule is a symbol the overview has
-- to hold a quote for. Fifty is far above what the feature is for — a reader
-- watching fifty levels is using a terminal, not this page — and far below what
-- would hurt.
--
-- Enforced in the function under the same advisory lock the count is taken in,
-- so two parallel creates cannot both see forty-nine. The same shape, and the
-- same reasoning, as `public.create_watchlist`.
create or replace function public.create_overview_alert_rule(
  input_symbol text, input_kind text, input_threshold numeric
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  normalized_symbol text := upper(btrim(input_symbol));
  existing_count integer;
  result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_threshold is null or input_threshold <= 0 then
    raise exception 'Alert threshold must be greater than zero' using errcode = '22023';
  end if;
  if input_kind not in ('price_above', 'price_below', 'percent_up', 'percent_down') then
    raise exception 'Unknown alert kind' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':overview-alerts', 0));

  select count(*) into existing_count
  from public.overview_alert_rules where user_id = requesting_user;
  if existing_count >= 50 then
    raise exception 'Alert limit reached' using errcode = '54000';
  end if;

  /*
    No `on conflict`. A duplicate must REACH the caller as 23505 so the action
    can say "มีการแจ้งเตือนแบบนี้อยู่แล้ว"; swallowing it would hand back nothing
    and leave the reader pressing a button that appears to do nothing.
  */
  insert into public.overview_alert_rules (user_id, symbol, kind, threshold)
  values (requesting_user, normalized_symbol, input_kind, input_threshold)
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.create_overview_alert_rule(text, text, numeric) from public, anon;
grant execute on function public.create_overview_alert_rule(text, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- `user_id`-bound on all four operations, the same model `watchlists` uses and
-- for the same reason: these are the reader's own rows and they reach them with
-- their own session. Reading, updating and deleting therefore need no function
-- at all — only creation does, because only creation has a count to enforce.
--
-- This is deliberately NOT the `label_history` / `daily_snapshot` shape, which
-- is service-role only with RLS on and no policy, because no client may reach
-- those. Mixing the two models up in either direction is how a table ends up
-- either unreachable or public.
alter table public.overview_alert_rules enable row level security;

drop policy if exists "Users can read own overview alert rules" on public.overview_alert_rules;
create policy "Users can read own overview alert rules" on public.overview_alert_rules
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users can create own overview alert rules" on public.overview_alert_rules;
create policy "Users can create own overview alert rules" on public.overview_alert_rules
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own overview alert rules" on public.overview_alert_rules;
create policy "Users can update own overview alert rules" on public.overview_alert_rules
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own overview alert rules" on public.overview_alert_rules;
create policy "Users can delete own overview alert rules" on public.overview_alert_rules
  for delete to authenticated using ((select auth.uid()) = user_id);

comment on table public.overview_alert_rules is
  'Thresholds a reader set for the Overview alert section. Evaluated at page read time only - no cron, no notification, no cooldown. The scheduled, notifying system is public.price_alerts and the two are deliberately separate.';

comment on column public.overview_alert_rules.threshold is
  'Always positive. A price for price_above/price_below, a percentage magnitude for percent_up/percent_down - the direction is carried by kind, never by the sign.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Fully reversible, and destructive only of rules readers created after it was
-- applied. Nothing else in the schema references this table, and no other
-- feature reads it.
--
--   begin;
--   drop function if exists public.create_overview_alert_rule(text, text, numeric);
--   drop table if exists public.overview_alert_rules;
--   commit;
--
-- The table is dropped rather than emptied because the feature's entire state
-- lives in it: with `PHASE2_ALERTS` off nothing reads these rows, so an empty
-- table left behind would be a schema object with no reader and no owner.
--
-- No hit or notification row is touched by either direction, because this
-- feature never wrote one.
