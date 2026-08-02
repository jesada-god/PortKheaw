import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'app/alerts/actions.ts'), 'utf8');

describe('alert server action contract', () => {
  it('reuses canonical symbol validation and validates target/cooldown again on the server', () => {
    expect(source).toContain('symbol: symbolSchema');
    expect(source).toContain('z.number().finite().positive()');
    expect(source).toContain('z.number().int().min(1).max(10080)');
    expect(source).toContain('alertInputSchema.safeParse(raw)');
  });

  it('derives ownership from the authenticated session instead of client input', () => {
    expect(source).toContain('client.auth.getUser()');
    expect(source).toContain('new AlertsRepository(client, user.id)');
    expect(source).not.toMatch(/\buserId\b/);
  });
});
