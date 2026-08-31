begin;

-- ===========================================================================
-- The purge lists catch up with the schema, and drop a table that never existed
-- ===========================================================================
--
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
-- QUEUE: 202608310003, 202608310004
--
-- Evidence: this file replaces two functions, and PostgREST reports relations
-- and columns, never function bodies — so nothing about its state is observable
-- from outside. Every table it adds or removes from the lists WAS probed:
-- `overview_alert_rules`, `overview_alert_hits` and `user_release_note_state`
-- all resolve; `notification_preferences` answers PGRST205.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `purge_account_data` and `account_residual_data_count` each carry a hardcoded
-- list of tables. Hardcoded on purpose — `202608280001` argues the case, and it
-- still holds: a convention would let a future table opt itself into a deletion
-- path silently, and the value of a list is that adding to it is a visible act.
--
-- The cost of that choice is this file. Three tables were added to the schema
-- after the lists were last written and neither list learned about them:
--
--     overview_alert_rules        202608300001
--     overview_alert_hits         202608310001
--     user_release_note_state     202608070003
--
-- All three are `user_id ... references auth.users(id) on delete cascade`, so
-- none of them BLOCKS a deletion the way `portfolio_transactions` did — they
-- vanish when the auth user does. This is therefore not a repeat of the
-- `on delete restrict` defect and no account is stuck because of it.
--
-- What it does break is the MEASUREMENT. `account_residual_data_count` is the
-- proof of completeness the reconciler checks before it deletes an auth user:
--
--     `data_purged` is a claim about the past; `account_residual_data_count` is
--     a measurement of the present, and it must read zero first.
--
-- A measurement that does not look at three of the tables holding the account's
-- rows reads zero while they are still there. The reconciler then deletes the
-- auth user, the cascade removes them, and the outcome is correct — by luck,
-- through a mechanism the count knows nothing about, and only for as long as
-- every future table keeps cascading. A proof that is right for a reason it
-- cannot state is not a proof.
--
-- ---------------------------------------------------------------------------
-- AND ONE TABLE THAT HAS NEVER EXISTED
-- ---------------------------------------------------------------------------
-- Both lists carry `notification_preferences`. There is no such table and there
-- never has been: `202608020001_notification_preferences.sql` adds COLUMNS to
-- `user_settings` — `daily_summary_time`, `daily_summary_last_local_date`,
-- `price_alert_extended_hours` — and creates `queued_notifications`. The name of
-- the migration became an entry in a list nobody re-read.
--
-- It has been harmless, because both loops guard on `information_schema.columns`
-- and skip a table that is not there. It is removed anyway. A list of tables the
-- deletion path must clear is a security-relevant inventory, and an entry that
-- silently matches nothing is the one shape in it that cannot be reviewed: the
-- next reader has no way to tell "deliberately covered" from "quietly skipped
-- for the last three months".
--
-- ---------------------------------------------------------------------------
-- ONE TABLE THAT IS DELIBERATELY *NOT* ADDED: `account_lifecycle`
-- ---------------------------------------------------------------------------
-- It was on the list of candidates and it must not be on the list of tables.
-- Adding it would break every account deletion in the product.
--
-- `account_lifecycle` is not the account's data — it is the STATE MACHINE that
-- tracks the deletion currently in progress, and `purge_account_data` runs in
-- the middle of that deletion, at step 4 of six. The very next statement in
-- `src/lib/account/account-deletion.ts` is
--
--     advance_account_deletion(userId, 'data_purged')
--
-- which selects the row `where status = 'deleting'` and, finding none, raises
-- `ACCOUNT_DELETION_NOT_STARTED` (42501). That raise is inside the same `try`
-- as the purge, so it is caught as `purge-failed`, the routine returns, and
-- step 6 — deleting the auth user — never runs.
--
-- The result would be worse than the `on delete restrict` defect it resembles.
-- That one left the account closed with its lifecycle row intact, so
-- `account_deletion_report` could still see it and `npm run account:reconcile`
-- could still finish it. Purging the lifecycle row leaves the account closed,
-- the auth user alive, and NOTHING IN THE REPORT — the row the reconciler
-- queries is the row that was just deleted. Every stuck account would be
-- invisible to the one tool built to find stuck accounts.
--
-- It needs no entry regardless: `user_id ... references auth.users(id) on delete
-- cascade`, so it goes when the auth user goes, which is the correct moment for
-- a record of a deletion to stop existing.

create or replace function public.purge_account_data(input_user_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  /*
   * Rows owned through a PARENT rather than through a user column, deleted
   * before the parent is. Each entry is (table, foreign key, parent table,
   * parent's user column), and the order within this list matters as much as
   * the list itself — a grandchild has to precede its child.
   *
   * Unchanged by this migration.
   */
  child constant text[][] := array[
    ['portfolio_transactions', 'portfolio_id', 'portfolios', 'user_id'],
    ['portfolio_option_positions', 'portfolio_id', 'portfolios', 'user_id'],
    ['portfolio_option_targets', 'portfolio_id', 'portfolios', 'user_id'],
    ['watchlist_items', 'watchlist_id', 'watchlists', 'user_id']
  ];
  owned constant text[][] := array[
    ['support_tickets', 'user_id'],
    ['refund_requests', 'user_id'],
    ['purchase_consents', 'user_id'],
    ['option_simulations', 'user_id'],
    ['stock_plans', 'user_id'],
    ['price_alerts', 'user_id'],
    /*
      The Overview alert pair, added here.

      HITS BEFORE RULES, and it is not arbitrary even though both are keyed on
      `user_id` and either order would work today. `overview_alert_hits.rule_id`
      references `overview_alert_rules` — removing the parent first would clear
      the children by cascade rather than by this list, which is the same
      "it works for a reason the list does not state" that this migration exists
      to end. Deleted in the order they depend.
    */
    ['overview_alert_hits', 'user_id'],
    ['overview_alert_rules', 'user_id'],
    ['notifications', 'user_id'],
    ['queued_notifications', 'user_id'],
    ['push_deliveries', 'user_id'],
    ['push_subscriptions', 'user_id'],
    /*
      Which release notes this reader has seen. Added here; it took the slot
      `notification_preferences` occupied, which is a table that does not exist.
    */
    ['user_release_note_state', 'user_id'],
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
  -- whose schema predates one of these tables — `stock_plans` included, on an
  -- environment that has not yet applied `202608150001` — skips that step
  -- instead of aborting the purge halfway.
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

  -- Then the children, each through the parents this account owns. Guarded on
  -- BOTH columns for the same reason the other loops are guarded on one: an
  -- environment missing either table skips the step rather than failing.
  foreach entry slice 1 in array child loop
    if exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[1]
        and candidate.column_name = entry[2]
    ) and exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[3]
        and candidate.column_name = entry[4]
    ) then
      execute format(
        'delete from public.%I where %I in (select id from public.%I where %I = $1)',
        entry[1], entry[2], entry[3], entry[4]
      ) using input_user_id;
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
   *
   * Deliberately kept for a different reason: `account_lifecycle`. It is the
   * state machine driving the deletion that is running right now — see the
   * header. It goes with the auth user, by cascade.
   */
end;
$$;

revoke all on function public.purge_account_data(uuid) from public, anon, authenticated;
grant execute on function public.purge_account_data(uuid) to service_role;

-- The completeness proof has to look for the same rows the purge removes, or
-- the reconciler would read zero over tables the purge never touched and delete
-- an auth user whose rows are still in them. The two lists below are the two
-- above, minus the `anonymized` group — a severed row is not residual data.
create or replace function public.account_residual_data_count(input_user_id uuid)
returns integer
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  child constant text[][] := array[
    ['portfolio_transactions', 'portfolio_id', 'portfolios', 'user_id'],
    ['portfolio_option_positions', 'portfolio_id', 'portfolios', 'user_id'],
    ['portfolio_option_targets', 'portfolio_id', 'portfolios', 'user_id'],
    ['watchlist_items', 'watchlist_id', 'watchlists', 'user_id']
  ];
  owned constant text[][] := array[
    ['support_tickets', 'user_id'],
    ['refund_requests', 'user_id'],
    ['purchase_consents', 'user_id'],
    ['option_simulations', 'user_id'],
    ['stock_plans', 'user_id'],
    ['price_alerts', 'user_id'],
    ['overview_alert_hits', 'user_id'],
    ['overview_alert_rules', 'user_id'],
    ['notifications', 'user_id'],
    ['queued_notifications', 'user_id'],
    ['push_deliveries', 'user_id'],
    ['push_subscriptions', 'user_id'],
    ['user_release_note_state', 'user_id'],
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

  foreach entry slice 1 in array child loop
    if exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[1]
        and candidate.column_name = entry[2]
    ) and exists (
      select 1 from information_schema.columns as candidate
      where candidate.table_schema = 'public'
        and candidate.table_name = entry[3]
        and candidate.column_name = entry[4]
    ) then
      execute format(
        'select count(*)::integer from public.%I where %I in (select id from public.%I where %I = $1)',
        entry[1], entry[2], entry[3], entry[4]
      ) into found_rows using input_user_id;
      total := total + coalesce(found_rows, 0);
    end if;
  end loop;

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
grant execute on function public.account_residual_data_count(uuid) to service_role;

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Reversible with no data loss: this migration changes two function bodies and
-- reads nothing, writes nothing and alters no table. Restoring the previous
-- pair from `202608280001` verbatim puts the database back exactly.
--
-- What reverting COSTS is the measurement, not the deletion. The three tables
-- added here all cascade from `auth.users`, so a reverted purge still ends with
-- their rows gone — it simply goes back to `account_residual_data_count`
-- reporting zero while they are still present, which is the state this file
-- exists to end.
--
-- Do not revert by re-adding `notification_preferences`. There is no such table;
-- the entry matched nothing before and would match nothing after.
