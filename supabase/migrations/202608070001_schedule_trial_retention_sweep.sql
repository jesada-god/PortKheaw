begin;

-- ===========================================================================
-- Actually schedule the trial-retention sweep
-- ===========================================================================
--
-- `202608060003` tried to schedule it and silently did not, on a database where
-- pg_cron is installed and working. The guard was wrong:
--
--   if to_regproc('cron.schedule') is null then … return; end if;
--
-- `cron.schedule` is **overloaded** — pg_cron ships both `cron.schedule(schedule,
-- command)` and `cron.schedule(job_name, schedule, command)`. A `regproc` cannot
-- represent an overloaded name, so `to_regproc` yields NULL for an ambiguous one
-- exactly as it does for a missing one. The block therefore took its "pg_cron is
-- not installed" path, raised a NOTICE, and returned — which is why applying that
-- migration reported success with no error and left no job behind.
--
-- The lesson generalises: **never probe for a function by bare name when the
-- extension overloads it.** Probe for something that cannot be ambiguous. A
-- relation can only exist once per schema, so `to_regclass('cron.job')` answers
-- "is pg_cron here?" with no overload to trip over — and it is already what
-- `trial_retention_status()` uses to report whether the job is scheduled, which is
-- how the discrepancy surfaced: the status function said "not scheduled" while the
-- migration that was supposed to schedule it had reported success.
--
-- Nothing else changes. The job is still `apply => true` resolving to
-- `reporting_only` while `trial_retention_config.enforcement_enabled` is false, so
-- installing this schedule does not delete a single row — it starts writing the
-- nightly audit line that says how many rows are due. Enforcement remains a
-- separate, deliberate decision: `docs/operations/trial-retention-enforcement.md`.
do $$
declare
  existing_job_id bigint;
begin
  -- Unambiguous: a relation name resolves or it does not. No overloads.
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; the trial retention sweep is not scheduled.';
    return;
  end if;

  -- Idempotent: re-running this migration leaves exactly one job, not two.
  select jobid into existing_job_id
  from cron.job where jobname = 'portkheaw-trial-retention' limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'portkheaw-trial-retention',
    '23 19 * * *',
    'select public.purge_expired_trial_identity_claims(gen_random_uuid(), true, null)'
  );

  raise notice 'trial retention sweep scheduled: portkheaw-trial-retention at 19:23 UTC.';
end;
$$;

commit;
