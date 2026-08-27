-- Account deletion could not delete an account that had ever recorded anything.
--
-- `purge_account_data` removes `portfolios` by `user_id`, and every table that
-- hangs off a portfolio keys on `portfolio_id` rather than on `user_id` — so
-- none of them is on its list, and none of them was ever removed. That was
-- survivable for as long as the child rows went with the parent: the original
-- `portfolio_transactions_portfolio_id_fkey` was `on delete cascade`.
--
-- `202607310002_multi_portfolios.sql` changed it to `on delete restrict`, which
-- is the right constraint and the reason this is a migration rather than a
-- revert. A ledger is the account's financial record; a portfolio must not be
-- destroyed out from under one by an UPDATE that happens to move a row. What the
-- change did not do is give the purge a way to remove the ledger deliberately.
--
-- So since 2026-07-31, `delete from public.portfolios where user_id = $1` has
-- raised 23503 for any account holding a transaction, `purge_account_data` has
-- aborted, and `deleteAccount` has returned `purge-failed` at step 4 — with the
-- account already closed to writes by step 1 and the auth user still present.
-- Reproduced against production on a QA account: residual 20 rows before, the
-- foreign-key error, residual 20 rows after.
--
-- THE FIX IS ORDER, NOT CASCADE. The children are deleted first, each scoped by
-- the parent rows this account owns, and the parents go afterwards exactly as
-- they did. Nothing is widened: `on delete restrict` stays, no table gains a
-- cascade, and a portfolio still cannot be removed by anything that has not
-- first removed its ledger on purpose.

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
   * `watchlist_items` is here for the same reason as the portfolio children,
   * and was equally invisible to a purge that only knew about `user_id`.
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
   */
end;
$$;

revoke all on function public.purge_account_data(uuid) from public, anon, authenticated;
grant execute on function public.purge_account_data(uuid) to service_role;

-- The completeness proof has to look for the same rows the purge removes, or
-- the reconciler would read zero over a ledger the purge never touched and
-- delete an auth user whose transactions are still in the table.
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
