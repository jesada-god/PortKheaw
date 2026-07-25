import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/202607250001_analytics_fundamentals_lkg.sql',
  'utf8',
);

describe('persistent fundamentals LKG migration', () => {
  it('stores the validated snapshot contract and period-based audit metadata', () => {
    expect(sql).toContain('create table public.analytics_fundamentals_lkg');
    expect(sql).toContain('financial_periods jsonb not null');
    expect(sql).toContain('source_as_of date not null');
    expect(sql).toContain('validated_at timestamptz not null');
    expect(sql).toContain('schema_version integer not null');
  });

  it('is service-role-only and never seeds financial values', () => {
    expect(sql).toContain(
      'revoke all on public.analytics_fundamentals_lkg from public, anon, authenticated',
    );
    expect(sql).toContain(
      'grant select, insert, update on public.analytics_fundamentals_lkg to service_role',
    );
    expect(sql).not.toMatch(/insert\s+into\s+public\.analytics_fundamentals_lkg/i);
  });
});
