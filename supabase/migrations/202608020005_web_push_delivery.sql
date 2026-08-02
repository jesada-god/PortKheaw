begin;

alter table public.push_subscriptions
  add column if not exists device_label text,
  add column if not exists enabled boolean not null default true,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_test_at timestamptz;

update public.push_subscriptions
set enabled = disabled_at is null
where enabled is distinct from (disabled_at is null);

alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_device_label_check;
alter table public.push_subscriptions
  add constraint push_subscriptions_device_label_check
  check (device_label is null or char_length(device_label) between 1 and 120);

-- A browser push endpoint identifies one browser subscription globally. Keep
-- the most recently seen owner if an older deployment recorded the same
-- endpoint under more than one account.
with ranked as (
  select
    id,
    row_number() over (
      partition by endpoint
      order by updated_at desc, created_at desc, id desc
    ) as position
  from public.push_subscriptions
)
delete from public.push_subscriptions as subscription
using ranked
where subscription.id = ranked.id
  and ranked.position > 1;

alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_user_id_endpoint_key;
create unique index if not exists push_subscriptions_endpoint_uidx
  on public.push_subscriptions (endpoint);

drop index if exists public.push_subscriptions_user_active_idx;
create index if not exists push_subscriptions_user_active_idx
  on public.push_subscriptions (user_id, updated_at desc)
  where enabled = true;

alter table public.push_deliveries
  add column if not exists channel text not null default 'web_push',
  add column if not exists provider_status text,
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz;

alter table public.push_deliveries
  drop constraint if exists push_deliveries_status_check;
alter table public.push_deliveries
  add constraint push_deliveries_status_check
  check (status in ('pending', 'processing', 'retrying', 'sent', 'failed', 'skipped'));

alter table public.push_deliveries
  drop constraint if exists push_deliveries_channel_check;
alter table public.push_deliveries
  add constraint push_deliveries_channel_check
  check (channel = 'web_push');

alter table public.push_deliveries
  drop constraint if exists push_deliveries_notification_id_subscription_id_key;
alter table public.push_deliveries
  add constraint push_deliveries_notification_subscription_channel_key
  unique (notification_id, subscription_id, channel);

alter table public.push_deliveries
  drop constraint if exists push_deliveries_subscription_id_fkey;
alter table public.push_deliveries
  alter column subscription_id drop not null;
alter table public.push_deliveries
  add constraint push_deliveries_subscription_id_fkey
  foreign key (subscription_id)
  references public.push_subscriptions(id)
  on delete set null;

drop index if exists public.push_deliveries_due_idx;
create index if not exists push_deliveries_due_idx
  on public.push_deliveries (next_attempt_at, created_at)
  where status in ('pending', 'retrying');
create index if not exists push_deliveries_stale_claim_idx
  on public.push_deliveries (claimed_at)
  where status = 'processing';

create or replace function public.upsert_push_subscription(
  input_endpoint text,
  input_expiration_time bigint,
  input_p256dh text,
  input_auth text,
  input_user_agent text,
  input_device_label text,
  input_now timestamptz
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  existing_subscription public.push_subscriptions%rowtype;
  result_id uuid;
begin
  if account_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_endpoint is null or char_length(input_endpoint) not between 1 and 2048
     or input_p256dh is null or char_length(input_p256dh) not between 1 and 512
     or input_auth is null or char_length(input_auth) not between 1 and 512
     or input_user_agent is not null and char_length(input_user_agent) > 200
     or input_device_label is not null and char_length(input_device_label) not between 1 and 120
     or input_expiration_time is not null and input_expiration_time < 0
  then
    raise exception 'Invalid push subscription' using errcode = '22023';
  end if;

  select * into existing_subscription
  from public.push_subscriptions
  where endpoint = input_endpoint
  for update;
  if found and existing_subscription.user_id <> account_id then
    -- A shared browser can sign out and sign in as another account. Detach all
    -- historical/outstanding deliveries before assigning this unguessable
    -- endpoint to the new cookie-bound owner, so no old-account payload can
    -- ever be delivered to the new account.
    delete from public.push_subscriptions
    where id = existing_subscription.id;
  end if;

  insert into public.push_subscriptions (
    user_id,
    endpoint,
    expiration_time,
    p256dh,
    auth,
    user_agent,
    device_label,
    enabled,
    disabled_at,
    failure_count,
    last_seen_at,
    updated_at
  ) values (
    account_id,
    input_endpoint,
    input_expiration_time,
    input_p256dh,
    input_auth,
    input_user_agent,
    input_device_label,
    true,
    null,
    0,
    input_now,
    input_now
  )
  on conflict (endpoint) do update set
    user_id = account_id,
    expiration_time = excluded.expiration_time,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    user_agent = excluded.user_agent,
    device_label = excluded.device_label,
    enabled = true,
    disabled_at = null,
    failure_count = 0,
    last_seen_at = input_now,
    updated_at = input_now
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.upsert_push_subscription(
  text, bigint, text, text, text, text, timestamptz
) from public, anon;
grant execute on function public.upsert_push_subscription(
  text, bigint, text, text, text, text, timestamptz
) to authenticated;

create or replace function public.claim_push_test(
  input_endpoint text,
  input_now timestamptz
)
returns table (
  subscription_id uuid,
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security definer set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  subscription public.push_subscriptions%rowtype;
begin
  if account_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into subscription
  from public.push_subscriptions
  where user_id = account_id
    and endpoint = input_endpoint
    and enabled = true
  for update;

  if not found then
    return;
  end if;

  if subscription.last_test_at is not null
     and subscription.last_test_at > input_now - interval '30 seconds'
  then
    return query select
      subscription.id,
      false,
      greatest(
        1,
        ceil(extract(epoch from (
          subscription.last_test_at + interval '30 seconds' - input_now
        )))::integer
      );
    return;
  end if;

  update public.push_subscriptions
  set last_test_at = input_now, updated_at = input_now
  where id = subscription.id;

  return query select subscription.id, true, 0;
end;
$$;

revoke all on function public.claim_push_test(text, timestamptz)
  from public, anon;
grant execute on function public.claim_push_test(text, timestamptz)
  to authenticated;

create or replace function public.claim_push_deliveries_service(
  input_limit integer,
  input_now timestamptz,
  input_claim_token uuid
)
returns setof public.push_deliveries
language sql
security definer set search_path = ''
as $$
  with candidates as (
    select delivery.id
    from public.push_deliveries as delivery
    where (
      delivery.status in ('pending', 'retrying')
      and delivery.next_attempt_at <= input_now
    ) or (
      delivery.status = 'processing'
      and delivery.claimed_at <= input_now - interval '5 minutes'
    )
    order by delivery.next_attempt_at, delivery.created_at
    for update skip locked
    limit greatest(1, least(coalesce(input_limit, 50), 100))
  )
  update public.push_deliveries as delivery
  set
    status = 'processing',
    claim_token = input_claim_token,
    claimed_at = input_now,
    updated_at = input_now
  from candidates
  where delivery.id = candidates.id
  returning delivery.*;
$$;

revoke all on function public.claim_push_deliveries_service(
  integer, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.claim_push_deliveries_service(
  integer, timestamptz, uuid
) to service_role;

create or replace function public.enqueue_notification_push()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.push_deliveries (
    notification_id,
    subscription_id,
    channel
  )
  select new.id, subscription.id, 'web_push'
  from public.push_subscriptions as subscription
  join public.user_settings as settings
    on settings.user_id = subscription.user_id
  where subscription.user_id = new.user_id
    and subscription.enabled = true
    and subscription.disabled_at is null
    and settings.push_enabled = true
    and case
      when new.type = 'price_alert' then settings.price_alerts_enabled
      when new.type = 'daily_summary' then settings.daily_summary_enabled
      else true
    end
  on conflict (notification_id, subscription_id, channel) do nothing;
  return new;
end;
$$;

revoke all on function public.enqueue_notification_push()
  from public, anon, authenticated;

commit;
