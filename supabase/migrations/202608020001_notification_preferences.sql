begin;

alter table public.user_settings
  add column if not exists daily_summary_time time not null default '18:00',
  add column if not exists daily_summary_last_local_date date,
  add column if not exists price_alert_extended_hours boolean not null default false;

alter table public.price_alerts
  add column if not exists was_matching boolean not null default false,
  add column if not exists last_observed_price numeric,
  add column if not exists last_observed_session text
    check (last_observed_session is null or last_observed_session in ('regular', 'pre-market', 'after-hours')),
  add column if not exists last_observed_source text,
  add column if not exists last_observed_at timestamptz;

alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('price_alert', 'daily_summary', 'quiet_hours_digest', 'system'));

create unique index if not exists notifications_user_idempotency_idx
  on public.notifications (user_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.queued_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('price_alert', 'daily_summary', 'system')),
  title text not null check (char_length(title) between 1 and 160),
  message text not null check (char_length(message) between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  release_after timestamptz not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists queued_notifications_user_idempotency_idx
  on public.queued_notifications (user_id, idempotency_key);
create index if not exists queued_notifications_release_idx
  on public.queued_notifications (release_after, created_at)
  where delivered_at is null;

alter table public.queued_notifications enable row level security;

drop policy if exists "Users can read own queued notifications" on public.queued_notifications;
create policy "Users can read own queued notifications" on public.queued_notifications
  for select to authenticated using ((select auth.uid()) = user_id);

grant select on public.queued_notifications to authenticated;
grant select, insert, update on public.queued_notifications to service_role;

create or replace function public.enqueue_account_notification_service(
  input_user_id uuid,
  input_type text,
  input_title text,
  input_message text,
  input_metadata jsonb,
  input_idempotency_key text,
  input_observed_at timestamptz
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  account_settings public.user_settings%rowtype;
  zone_name text;
  local_now timestamp;
  local_clock time;
  quiet_now boolean := false;
  release_local timestamp;
  release_at timestamptz;
  result_id uuid;
begin
  if input_type not in ('price_alert', 'daily_summary', 'system') then
    raise exception 'Unsupported notification type' using errcode = '22023';
  end if;
  if input_title is null or char_length(input_title) not between 1 and 160
     or input_message is null or char_length(input_message) not between 1 and 1000
     or input_idempotency_key is null or char_length(input_idempotency_key) not between 1 and 200
  then
    raise exception 'Invalid notification payload' using errcode = '22023';
  end if;

  select * into account_settings
  from public.user_settings where user_id = input_user_id;
  if not found then raise exception 'User settings not found' using errcode = 'P0002'; end if;

  zone_name := coalesce(nullif(account_settings.timezone, ''), 'Asia/Bangkok');
  begin
    perform input_observed_at at time zone zone_name;
  exception when invalid_parameter_value then
    raise exception 'Invalid timezone' using errcode = '22023';
  end;
  local_now := input_observed_at at time zone zone_name;
  local_clock := local_now::time;

  if account_settings.quiet_hours_enabled
     and account_settings.quiet_hours_start <> account_settings.quiet_hours_end then
    if account_settings.quiet_hours_start < account_settings.quiet_hours_end then
      quiet_now := local_clock >= account_settings.quiet_hours_start
        and local_clock < account_settings.quiet_hours_end;
      release_local := local_now::date + account_settings.quiet_hours_end;
    else
      quiet_now := local_clock >= account_settings.quiet_hours_start
        or local_clock < account_settings.quiet_hours_end;
      release_local := case
        when local_clock >= account_settings.quiet_hours_start
          then local_now::date + 1 + account_settings.quiet_hours_end
        else local_now::date + account_settings.quiet_hours_end
      end;
    end if;
  end if;

  if quiet_now then
    release_at := release_local at time zone zone_name;
    insert into public.queued_notifications (
      user_id, type, title, message, metadata, idempotency_key, release_after, created_at
    ) values (
      input_user_id, input_type, input_title, input_message,
      coalesce(input_metadata, '{}'::jsonb), input_idempotency_key, release_at, input_observed_at
    )
    on conflict (user_id, idempotency_key) do update
      set idempotency_key = excluded.idempotency_key
    returning id into result_id;
    return result_id;
  end if;

  insert into public.notifications (
    user_id, type, title, message, metadata, idempotency_key, created_at
  ) values (
    input_user_id, input_type, input_title, input_message,
    coalesce(input_metadata, '{}'::jsonb), input_idempotency_key, input_observed_at
  )
  on conflict (user_id, idempotency_key)
    where idempotency_key is not null
    do update set idempotency_key = excluded.idempotency_key
  returning id into result_id;
  return result_id;
end;
$$;

revoke all on function public.enqueue_account_notification_service(uuid, text, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_account_notification_service(uuid, text, text, text, jsonb, text, timestamptz)
  to service_role;

-- Retire the owner-supplied quote path. Price notifications must only enter
-- through the service-role canonical accepted-price pipeline below.
revoke all on function public.trigger_price_alert(uuid, numeric, numeric, timestamptz, text, text)
  from public, anon, authenticated;

drop function if exists public.trigger_price_alert_service(
  uuid, numeric, numeric, timestamptz, text, text, text
);

create function public.trigger_price_alert_service(
  alert_id uuid,
  observed_price numeric,
  observed_change_percent numeric,
  observed_at timestamptz,
  observed_session text,
  observed_source text,
  notification_title text,
  notification_message text,
  input_idempotency_key text
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  owned_alert public.price_alerts%rowtype;
  account_settings public.user_settings%rowtype;
  matches_now boolean;
  result_id uuid;
begin
  if observed_price is null or observed_price <= 0
     or observed_session not in ('regular', 'pre-market', 'after-hours')
     or observed_source is null or char_length(observed_source) not between 1 and 120
  then return null; end if;

  select * into owned_alert from public.price_alerts
  where id = alert_id and enabled = true
  for update;
  if not found then return null; end if;

  select * into account_settings from public.user_settings
  where user_id = owned_alert.user_id;
  if not found or account_settings.price_alerts_enabled is false then
    update public.price_alerts
    set last_evaluated_at = observed_at, updated_at = now()
    where id = owned_alert.id;
    return null;
  end if;
  if observed_session <> 'regular' and account_settings.price_alert_extended_hours is false then
    update public.price_alerts
    set last_evaluated_at = observed_at, updated_at = now()
    where id = owned_alert.id;
    return null;
  end if;

  matches_now :=
    (owned_alert.condition = 'above' and observed_price >= owned_alert.target_value)
    or (owned_alert.condition = 'below' and observed_price <= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_up' and observed_change_percent >= owned_alert.target_value)
    or (owned_alert.condition = 'percent_change_down' and observed_change_percent <= -owned_alert.target_value);

  update public.price_alerts set
    last_evaluated_at = observed_at,
    last_observed_price = observed_price,
    last_observed_session = observed_session,
    last_observed_source = observed_source,
    last_observed_at = observed_at,
    was_matching = matches_now,
    updated_at = now()
  where id = owned_alert.id;

  if not matches_now or owned_alert.was_matching then return null; end if;

  select public.enqueue_account_notification_service(
    owned_alert.user_id,
    'price_alert',
    notification_title,
    notification_message,
    jsonb_build_object(
      'symbol', owned_alert.symbol,
      'condition', owned_alert.condition,
      'targetValue', owned_alert.target_value,
      'triggeredPrice', observed_price,
      'changePercent', observed_change_percent,
      'session', observed_session,
      'source', observed_source,
      'observedAt', observed_at,
      'href', '/stock/' || owned_alert.symbol
    ),
    input_idempotency_key,
    observed_at
  ) into result_id;

  update public.price_alerts
  set last_triggered_at = observed_at, updated_at = now()
  where id = owned_alert.id;
  return result_id;
end;
$$;

revoke all on function public.trigger_price_alert_service(
  uuid, numeric, numeric, timestamptz, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.trigger_price_alert_service(
  uuid, numeric, numeric, timestamptz, text, text, text, text, text
) to service_role;

create or replace function public.flush_queued_notifications_service(input_now timestamptz)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  pending record;
  digest_key text;
  delivered integer := 0;
begin
  for pending in
    select
      user_id,
      min(release_after) as first_release,
      count(*) as item_count,
      jsonb_agg(jsonb_build_object(
        'type', type,
        'title', title,
        'message', message,
        'metadata', metadata,
        'createdAt', created_at
      ) order by created_at) as items
    from public.queued_notifications
    where delivered_at is null and release_after <= input_now
    group by user_id
  loop
    digest_key := 'quiet-hours-digest:' || md5(
      pending.user_id::text || ':' || pending.first_release::text
    );
    insert into public.notifications (
      user_id, type, title, message, metadata, idempotency_key, created_at
    ) values (
      pending.user_id,
      'quiet_hours_digest',
      'สรุปการแจ้งเตือนที่พักไว้',
      left('มี ' || pending.item_count || ' รายการระหว่างช่วงงดแจ้งเตือน เปิดดูรายละเอียดได้ในรายการนี้', 1000),
      jsonb_build_object('count', pending.item_count, 'items', pending.items),
      digest_key,
      input_now
    )
    on conflict (user_id, idempotency_key)
      where idempotency_key is not null
      do nothing;

    update public.queued_notifications
    set delivered_at = input_now
    where user_id = pending.user_id
      and delivered_at is null
      and release_after <= input_now;
    delivered := delivered + pending.item_count;
  end loop;
  return delivered;
end;
$$;

revoke all on function public.flush_queued_notifications_service(timestamptz)
  from public, anon, authenticated;
grant execute on function public.flush_queued_notifications_service(timestamptz)
  to service_role;

commit;
