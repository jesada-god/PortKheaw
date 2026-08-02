import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSql = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  'utf8',
).replace(/\s+/g, ' ').toLowerCase();

const phase9 = readSql(
  'supabase/migrations/202607180010_phase_9_background_alerts_push.sql',
);
const push = readSql(
  'supabase/migrations/202608020005_web_push_delivery.sql',
);
const testAudit = readSql(
  'supabase/migrations/202608020006_push_test_audit.sql',
);
const testAuditFix = readSql(
  'supabase/migrations/202608020007_fix_push_test_audit_lookup.sql',
);

describe('production web push migration', () => {
  it('keeps subscriptions owner-scoped and supports multiple devices', () => {
    expect(phase9).toContain(
      'alter table public.push_subscriptions enable row level security',
    );
    expect(phase9).toContain('(select auth.uid()) = user_id');
    expect(push).toContain('push_subscriptions_endpoint_uidx');
    expect(push).toContain('device_label text');
    expect(push).toContain('enabled boolean');
    expect(push).toContain('last_success_at timestamptz');
    expect(push).toContain('on conflict (endpoint) do update');
    expect(push).toContain('account_id uuid := auth.uid()');
    expect(push).toContain(
      'existing_subscription.user_id <> account_id',
    );
    expect(push).toContain(
      'delete from public.push_subscriptions where id = existing_subscription.id',
    );
  });

  it('deduplicates each notification channel and atomically claims work', () => {
    expect(push).toContain(
      'unique (notification_id, subscription_id, channel)',
    );
    expect(push).toContain("channel = 'web_push'");
    expect(push).toContain('for update skip locked');
    expect(push).toContain("status = 'processing'");
    expect(push).toContain("interval '5 minutes'");
    expect(push).toContain(
      'grant execute on function public.claim_push_deliveries_service',
    );
    expect(push).toContain('to service_role');
  });

  it('rate limits test delivery per owned endpoint under a row lock', () => {
    expect(push).toContain('create or replace function public.claim_push_test');
    expect(push).toContain("interval '30 seconds'");
    expect(push).toContain('for update;');
    expect(push).toContain(
      'grant execute on function public.claim_push_test(text, timestamptz) to authenticated',
    );
  });

  it('preserves delivery history when an expired endpoint is removed', () => {
    expect(push).toContain('alter column subscription_id drop not null');
    expect(push).toContain('on delete set null');
    expect(push).toContain('provider_status text');
    expect(`${phase9} ${push}`).toContain('last_error_code');
  });

  it('records a user-triggered test in the Inbox and targets one delivery', () => {
    expect(testAudit).toContain(
      'create or replace function public.create_push_test_notification',
    );
    expect(testAudit).toContain("'push_target_subscription_id'");
    expect(testAudit).toContain("'push_test', true");
    expect(testAudit).toContain(
      "case when is_test_push then 'processing' else 'pending' end",
    );
    expect(testAudit).toContain(
      'grant execute on function public.create_push_test_notification',
    );
    expect(testAudit).toContain('to authenticated');
    expect(testAuditFix).toContain(
      'where delivery.notification_id = notification_uuid',
    );
  });
});
