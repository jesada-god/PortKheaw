begin;

-- ---------------------------------------------------------------------------
-- Saved stock plans join the account-deletion pair
-- ---------------------------------------------------------------------------
--
-- `202608150001_stock_plans.sql` created `public.stock_plans` and deliberately
-- stopped short of touching account deletion, on the grounds that the two table
-- lists involved are a MATCHED PAIR and that changing them belongs here:
--
--   * `purge_account_data`             — what the pipeline removes;
--   * `account_residual_data_count`    — what the reconciler counts before it
--                                        will delete the auth user.
--
-- A table added to one and not the other is the failure that migration was
-- avoiding: added to the purge only, the reconciler under-counts and can never
-- notice a purge that missed rows; added to the count only, `residual_rows`
-- never reaches zero and every deletion stalls at `awaiting_auth_delete`
-- forever. So both are recreated here, in one transaction, with exactly one
-- entry added to each list and nothing else changed.
--
-- Why an explicit entry at all, when `stock_plans.user_id` already carries
-- `on delete cascade` to `auth.users`: the cascade fires when the auth user is
-- deleted, and the auth user is deliberately deleted LAST and may fail. The
-- pipeline's promise is that nothing of the person is left behind even when that
-- last step never succeeds, and that promise is kept by the explicit list, not
-- by the cascade. The cascade remains the backstop it always was — it is not
-- touched, not duplicated and not replaced.
--
-- Both routines are recreated with `create or replace`, which is what makes this
-- file re-runnable: the signatures, volatility, `security definer` context and
-- grants are unchanged, so applying it twice leaves the same two routines.
-- Nothing is dropped, no policy is altered, no foreign key is redefined, and
-- `delete_own_account` keeps the refusal it was given.

-- Removes everything the account created, and anonymizes what accounting and
-- audit require us to keep. Unchanged from `202608060002` except for the one
-- added row — see that migration for why this is explicit rather than left to
-- `on delete cascade`.
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
    -- Saved plans. Nothing depends on a plan, so it may be removed at any point
    -- in this list; it sits with the other tool artefacts the reader produced.
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

-- How much of the account's own data is still there. The completeness proof the
-- reconciler requires before it will delete an auth user, and therefore the same
-- table list as `purge_account_data` above — including `stock_plans`, so that a
-- saved plan the purge missed is a plan the reconciler refuses to delete the
-- auth user over, rather than one it never looked for.
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
