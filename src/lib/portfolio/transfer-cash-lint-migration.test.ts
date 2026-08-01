import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/202608020002_transfer_cash_lint.sql',
), 'utf8');

describe('transfer cash lint migration', () => {
  it('keeps the atomic paired transfer contract without unused result variables', () => {
    expect(sql).toContain('create or replace function public.transfer_portfolio_cash');
    expect(sql).toContain('order by id');
    expect(sql).toContain('for update');
    expect(sql.match(/on conflict \(portfolio_id, idempotency_key\)/g)).toHaveLength(2);
    expect(sql).toContain('return transfer_key');
    expect(sql).not.toContain('first_id');
    expect(sql).not.toContain('second_id');
    expect(sql).not.toContain('returning id into');
  });

  it('preserves owner-only execution', () => {
    expect(sql).toContain('user_id = requesting_user');
    expect(sql).toContain('revoke all on function public.transfer_portfolio_cash');
    expect(sql).toContain('to authenticated');
  });
});
