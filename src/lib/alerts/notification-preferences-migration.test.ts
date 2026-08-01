import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202608020001_notification_preferences.sql'),
  'utf8',
).replace(/\s+/g, ' ').toLowerCase();

describe('notification preferences migration', () => {
  it('adds account settings with explicit defaults and owner-only RLS', () => {
    expect(sql).toContain("daily_summary_time time not null default '18:00'");
    expect(sql).toContain('price_alert_extended_hours boolean not null default false');
    expect(sql).toContain('alter table public.queued_notifications enable row level security');
    expect(sql).toContain('using ((select auth.uid()) = user_id)');
  });

  it('deduplicates daily summaries and queues quiet-hour items for a digest', () => {
    expect(sql).toContain('notifications_user_idempotency_idx');
    expect(sql).toContain('queued_notifications_user_idempotency_idx');
    expect(sql).toContain('revoke all on function public.trigger_price_alert');
    expect(sql).toContain('flush_queued_notifications_service');
    expect(sql).toContain("'quiet_hours_digest'");
  });

  it('implements crossing, re-arm, session gating and audited metadata', () => {
    expect(sql).toContain('was_matching = matches_now');
    expect(sql).toContain('if not matches_now or owned_alert.was_matching then return null');
    expect(sql).toContain("observed_session <> 'regular'");
    expect(sql).toContain("'triggeredprice', observed_price");
    expect(sql).toContain("'source', observed_source");
    expect(sql).toContain("'observedat', observed_at");
  });

  it('keeps service functions unavailable to browser roles', () => {
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
  });
});
