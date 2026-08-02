begin;

-- A user-triggered test push is still an account notification: create one
-- Inbox row and one targeted delivery row, while keeping normal notifications
-- fan-out behavior unchanged.
create or replace function public.enqueue_notification_push()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  is_test_push boolean := coalesce(new.metadata ->> 'push_test', 'false') = 'true';
begin
  insert into public.push_deliveries (
    notification_id,
    subscription_id,
    channel,
    status,
    provider_status,
    claim_token,
    claimed_at
  )
  select
    new.id,
    subscription.id,
    'web_push',
    case when is_test_push then 'processing' else 'pending' end,
    case when is_test_push then 'test-push' else null end,
    case when is_test_push then gen_random_uuid() else null end,
    case when is_test_push then clock_timestamp() else null end
  from public.push_subscriptions as subscription
  join public.user_settings as settings
    on settings.user_id = subscription.user_id
  where subscription.user_id = new.user_id
    and subscription.enabled = true
    and subscription.disabled_at is null
    and settings.push_enabled = true
    and (
      nullif(new.metadata ->> 'push_target_subscription_id', '') is null
      or subscription.id::text = new.metadata ->> 'push_target_subscription_id'
    )
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

create or replace function public.create_push_test_notification(
  input_subscription_id uuid,
  input_now timestamptz
)
returns table (
  notification_id uuid,
  delivery_id uuid
)
language plpgsql
security definer set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  notification_uuid uuid := gen_random_uuid();
  delivery_uuid uuid;
begin
  if account_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.push_subscriptions
    where id = input_subscription_id
      and user_id = account_id
      and enabled = true
      and disabled_at is null
  ) then
    raise exception 'Push subscription was not found';
  end if;

  insert into public.notifications (
    id,
    user_id,
    type,
    title,
    message,
    metadata,
    idempotency_key,
    created_at
  ) values (
    notification_uuid,
    account_id,
    'system',
    'PortKheaw',
    'PortKheaw พร้อมแจ้งเตือนแล้ว',
    jsonb_build_object(
      'href', '/notifications',
      'push_test', true,
      'push_target_subscription_id', input_subscription_id::text
    ),
    'push-test:' || notification_uuid::text,
    coalesce(input_now, clock_timestamp())
  );

  select id
  into delivery_uuid
  from public.push_deliveries
  where notification_id = notification_uuid
    and subscription_id = input_subscription_id
    and channel = 'web_push';

  if delivery_uuid is null then
    raise exception 'Push test delivery was not created';
  end if;

  return query select notification_uuid, delivery_uuid;
end;
$$;

revoke all on function public.create_push_test_notification(uuid, timestamptz)
  from public, anon;
grant execute on function public.create_push_test_notification(uuid, timestamptz)
  to authenticated;

commit;
