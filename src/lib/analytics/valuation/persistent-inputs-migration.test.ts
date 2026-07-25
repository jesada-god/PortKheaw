import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = 'supabase/migrations/202607250002_analytics_valuation_inputs_lkg.sql';

describe('valuation input LKG migration', () => {
  it('creates a service-role-only persistent store with the complete cache key', () => {
    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('create table public.analytics_valuation_inputs_lkg');
    expect(sql).toContain('primary key (scope, owner_key, metric, period)');
    expect(sql).toContain(
      'revoke all on public.analytics_valuation_inputs_lkg from public, anon, authenticated',
    );
    expect(sql).toContain(
      'grant select, insert, update on public.analytics_valuation_inputs_lkg to service_role',
    );
    expect(sql).not.toMatch(/insert\s+into\s+public\.analytics_valuation_inputs_lkg/i);
  });
});
