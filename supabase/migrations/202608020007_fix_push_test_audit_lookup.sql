begin;

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
    from public.push_subscriptions as subscription
    where subscription.id = input_subscription_id
      and subscription.user_id = account_id
      and subscription.enabled = true
      and subscription.disabled_at is null
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

  select delivery.id
  into delivery_uuid
  from public.push_deliveries as delivery
  where delivery.notification_id = notification_uuid
    and delivery.subscription_id = input_subscription_id
    and delivery.channel = 'web_push';

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
