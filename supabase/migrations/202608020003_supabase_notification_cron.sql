begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.configure_notification_cron_service(
  input_url text,
  input_secret text
)
returns bigint
language plpgsql
security definer set search_path = ''
as $$
declare
  existing_job_id bigint;
  stored_secret_id uuid;
  scheduled_job_id bigint;
begin
  if input_url <> 'https://portkheaw.app/api/cron/alerts' then
    raise exception 'Unsupported cron endpoint' using errcode = '22023';
  end if;
  if input_secret is null or char_length(input_secret) not between 16 and 512 then
    raise exception 'Invalid cron secret' using errcode = '22023';
  end if;

  select id into stored_secret_id
  from vault.decrypted_secrets
  where name = 'portkheaw_notification_cron_secret'
  limit 1;

  if stored_secret_id is null then
    select vault.create_secret(
      input_secret,
      'portkheaw_notification_cron_secret',
      'Bearer secret for the PortKheaw background notification endpoint'
    ) into stored_secret_id;
  else
    perform vault.update_secret(
      stored_secret_id,
      input_secret,
      'portkheaw_notification_cron_secret',
      'Bearer secret for the PortKheaw background notification endpoint'
    );
  end if;

  select jobid into existing_job_id
  from cron.job
  where jobname = 'portkheaw-background-notifications'
  limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  select cron.schedule(
    'portkheaw-background-notifications',
    '*/15 * * * *',
    format(
      $command$
        select net.http_get(
          url := %L,
          headers := jsonb_build_object(
            'Authorization',
            'Bearer ' || (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'portkheaw_notification_cron_secret'
              limit 1
            )
          ),
          timeout_milliseconds := 55000
        );
      $command$,
      input_url
    )
  ) into scheduled_job_id;

  return scheduled_job_id;
end;
$$;

revoke all on function public.configure_notification_cron_service(text, text)
  from public, anon, authenticated;
grant execute on function public.configure_notification_cron_service(text, text)
  to service_role;

commit;
