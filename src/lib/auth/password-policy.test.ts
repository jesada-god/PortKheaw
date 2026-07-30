import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULES,
  evaluatePassword,
  passwordByteLength,
} from './password-policy';

/**
 * The checklist the visitor reads and the schema the server enforces are the
 * same array. These lock that in: any rule that ticks green must also pass
 * `evaluatePassword`, and a password that fails a rule must be refused.
 */
describe('password policy', () => {
  it('accepts a password that satisfies every visible rule', () => {
    const result = evaluatePassword('PortKheaw#2026');
    expect(result.valid).toBe(true);
    expect(result.satisfied).toEqual(PASSWORD_RULES.map((rule) => rule.id));
    expect(result.error).toBeUndefined();
  });

  it.each([
    ['Ab1!', 'length'],
    ['portkheaw1!', 'uppercase'],
    ['PortKheaw!', 'digit'],
    ['PortKheaw12', 'symbol'],
  ])('refuses %s because the %s rule fails', (password, failingRule) => {
    const result = evaluatePassword(password);
    expect(result.valid).toBe(false);
    expect(result.satisfied).not.toContain(failingRule);
    expect(result.error).toBeTruthy();
  });

  it('reports exactly the rules a partial password satisfies, so the checklist can render them', () => {
    // Long enough and has a digit, but no capital and no symbol.
    expect(evaluatePassword('portkheaw1234').satisfied).toEqual(['length', 'digit']);
  });

  it('never trims, cases or otherwise transforms the password it is given', () => {
    const padded = ' PortKheaw#2026 ';
    expect(evaluatePassword(padded).valid).toBe(true);
    // A trimming implementation would report 14 bytes, not 16.
    expect(passwordByteLength(padded)).toBe(16);
  });

  it('measures the bcrypt limit in bytes, not characters, so multi-byte input is not silently truncated', () => {
    // Thai characters are three bytes each: 24 of them already exceed 72 bytes.
    const thai = `${'ก'.repeat(24)}A1!`;
    expect(thai.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(passwordByteLength(thai)).toBeGreaterThan(MAX_PASSWORD_BYTES);
    const result = evaluatePassword(thai);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ยาวเกินไป');
  });

  it('states the minimum length in the rule label so the UI cannot drift from the check', () => {
    const lengthRule = PASSWORD_RULES.find((rule) => rule.id === 'length');
    expect(lengthRule?.label).toContain(String(MIN_PASSWORD_LENGTH));
    expect(lengthRule?.test('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(lengthRule?.test('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });
});
