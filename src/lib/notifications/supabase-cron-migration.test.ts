import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/202608020003_supabase_notification_cron.sql',
), 'utf8');

describe('Supabase notification scheduler migration', () => {
  it('schedules the protected endpoint every fifteen minutes through Vault', () => {
    expect(sql).toContain("create extension if not exists pg_cron");
    expect(sql).toContain("create extension if not exists pg_net");
    expect(sql).toContain("'*/15 * * * *'");
    expect(sql).toContain("'https://portkheaw.app/api/cron/alerts'");
    expect(sql).toContain('vault.decrypted_secrets');
    expect(sql).toContain('net.http_get');
    expect(sql).toContain('timeout_milliseconds := 55000');
    expect(sql).not.toContain('CRON_SECRET=');
  });

  it('keeps scheduler configuration service-role-only and idempotent', () => {
    expect(sql).toContain('portkheaw-background-notifications');
    expect(sql).toContain('cron.unschedule(existing_job_id)');
    expect(sql).toContain('vault.update_secret');
    expect(sql).toContain('revoke all on function public.configure_notification_cron_service');
    expect(sql).toContain('to service_role');
  });
});
