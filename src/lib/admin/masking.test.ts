import { describe, expect, it } from 'vitest';
import { looksSensitive, maskAccountRef, maskEmail, maskIdentifier } from './masking';

describe('mailbox masking', () => {
  it('keeps the domain and enough of the local part to tell two rows apart', () => {
    expect(maskEmail('jessada@example.com')).toBe('je•••@example.com');
    expect(maskEmail('jessadb@example.com')).toBe('je•••@example.com');
    expect(maskEmail('alice@portkheaw.app')).toBe('al•••@portkheaw.app');
  });

  it('reveals less, not more, for a short local part', () => {
    expect(maskEmail('a@example.com')).toBe('a•••@example.com');
    expect(maskEmail('ab@example.com')).toBe('a•••@example.com');
  });

  it('never returns the input for a value that is not an address', () => {
    // The dangerous failure is falling through to the raw string.
    expect(maskEmail('not-an-address')).not.toContain('not-an-address');
    expect(maskEmail('trailing@')).not.toBe('trailing@');
    expect(maskEmail('@leading.com')).not.toBe('@leading.com');
  });

  it('answers a placeholder for nothing at all', () => {
    expect(maskEmail(null)).toBe('—');
    expect(maskEmail(undefined)).toBe('—');
    expect(maskEmail('   ')).toBe('—');
  });

  it('handles an address containing more than one @', () => {
    expect(maskEmail('we"ird@x@example.com')).toBe('we•••@example.com');
  });
});

describe('identifier masking', () => {
  it('keeps a prefix and a suffix, never the middle', () => {
    expect(maskIdentifier('in_1QxAbCdEfGhIjKlMn')).toBe('in_1Q…KlMn');
    expect(maskIdentifier('cus_ABCDEFGHIJKLMNOP')).toBe('cus_A…MNOP');
  });

  it('masks a short identifier entirely rather than revealing it', () => {
    // A prefix of a short value is most of the value.
    expect(maskIdentifier('in_1234')).toBe('i••••••');
    expect(maskIdentifier('ab')).toBe('a•');
  });

  it('never leaks the full value at any length', () => {
    for (const length of [1, 2, 8, 9, 20, 64]) {
      const value = 'x'.repeat(length);
      expect(maskIdentifier(value)).not.toBe(value);
    }
  });

  it('answers a placeholder for nothing at all', () => {
    expect(maskIdentifier(null)).toBe('—');
    expect(maskIdentifier('')).toBe('—');
  });
});

describe('account references', () => {
  it('shortens our own uuid to its first group', () => {
    expect(maskAccountRef('52e7b434-1dca-4636-88ab-ea9bdf063761')).toBe('52e7b434');
    expect(maskAccountRef(null)).toBe('—');
  });
});

describe('the sensitivity tripwire', () => {
  it('recognises the shapes that must never render', () => {
    expect(looksSensitive('sk_live_ABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksSensitive('sk_test_ABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksSensitive('whsec_ABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksSensitive('cus_ABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksSensitive('4242424242424242')).toBe(true);
    expect(looksSensitive('eyJhbGciOiJIUzI1NiIsInR5cCI6.eyJzdWIiOiIxMjM0.abc')).toBe(true);
  });

  it('does not fire on the values the console legitimately renders', () => {
    expect(looksSensitive('je•••@example.com')).toBe(false);
    expect(looksSensitive('in_1Q…KlMn')).toBe(false);
    expect(looksSensitive('52e7b434')).toBe(false);
    expect(looksSensitive('pro_monthly')).toBe(false);
    expect(looksSensitive('39,900')).toBe(false);
  });

  it('agrees with the maskers: nothing they produce is sensitive', () => {
    expect(looksSensitive(maskEmail('jessada@example.com'))).toBe(false);
    expect(looksSensitive(maskIdentifier('in_1QxAbCdEfGhIjKlMn'))).toBe(false);
    expect(looksSensitive(maskIdentifier('cus_ABCDEFGHIJKLMNOP'))).toBe(false);
  });
});
