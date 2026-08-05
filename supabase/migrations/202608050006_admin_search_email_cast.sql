begin;

-- Phase 5.3 — the operator account search returned no rows at all.
--
-- `auth.users.email` is `character varying(255)` on a real Supabase project,
-- while `admin_search_accounts` declares its second output column as `text`.
-- Postgres refuses the mismatch at execution time with 42804 — "structure of
-- query does not match function result type" — so every search failed and the
-- console rendered its "could not read billing" state for any query.
--
-- The local migration harness declares its stand-in `auth.users.email` as
-- `text`, which is why the test suite agreed with itself and missed this. The
-- harness now uses `varchar(255)` so this class of mismatch fails locally.
--
-- Same signature, same behaviour, one explicit cast. Additive and forward-only.
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
    -- The cast is the fix. `auth.users.email` is varchar(255) upstream, and a
    -- set-returning function will not widen it to `text` on its own.
    account.email::text,
    profile.full_name::text,
    coalesce(roles.role, 'user')::text,
    coalesce(subscription.tier, 'basic')::text,
    coalesce(subscription.status, 'basic')::text,
    public.resolve_effective_subscription_tier(account.id, statement_timestamp())::text,
    subscription.billing_plan_key::text,
    subscription.billing_interval::text,
    subscription.billing_provider_mode::text,
    subscription.billing_collection_method::text,
    subscription.current_period_end,
    coalesce(subscription.cancel_at_period_end, false),
    subscription.access_revoked_at,
    subscription.access_revoked_reason::text,
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
    account.email::text ilike '%' || needle || '%'
    or profile.full_name ilike '%' || needle || '%'
    or account.id::text = needle
  )
  order by account.created_at desc
  limit row_limit;
end;
$$;

revoke all on function public.admin_search_accounts(text, integer) from public, anon;
grant execute on function public.admin_search_accounts(text, integer) to authenticated;

commit;
