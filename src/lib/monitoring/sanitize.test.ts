import { describe, expect, it } from 'vitest';
import { allowedContextKeys, sanitizeContext, sanitizeError, sanitizeText } from './sanitize';

/**
 * An exception report is the easiest place in a product to leak a secret. These
 * are the shapes that must never survive one.
 */

describe('redaction', () => {
  it('removes provider keys and webhook secrets', () => {
    expect(sanitizeText('using sk_live_ABCDEFGHIJKLMNOP now'))
      .toBe('using [redacted:provider-key] now');
    expect(sanitizeText('sk_test_ABCDEFGHIJKLMNOP')).toBe('[redacted:provider-key]');
    expect(sanitizeText('whsec_ABCDEFGHIJKLMNOP')).toBe('[redacted:webhook-secret]');
    expect(sanitizeText('rk_live_ABCDEFGHIJKLMNOP')).toBe('[redacted:provider-key]');
  });

  it('removes a JWT, which is what a Supabase service key looks like', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij';
    expect(sanitizeText(`token=${jwt}`)).not.toContain(jwt);
    expect(sanitizeText(jwt)).toBe('[redacted:token]');
  });

  it('removes credentials copied out of a header dump', () => {
    expect(sanitizeText('Authorization: Bearer abc.def.ghi')).toContain('[redacted:credential]');
    expect(sanitizeText('apikey=supersecretvalue')).toContain('[redacted:credential]');
  });

  it('removes provider object identifiers', () => {
    expect(sanitizeText('invoice in_1QxAbCdEfGhIjKlMn failed'))
      .toBe('invoice [redacted:provider-id] failed');
    expect(sanitizeText('cus_ABCDEFGHIJKLMN')).toBe('[redacted:provider-id]');
  });

  it('removes anything card-shaped', () => {
    expect(sanitizeText('4242 4242 4242 4242')).toBe('[redacted:pan]');
    expect(sanitizeText('4242424242424242')).toBe('[redacted:pan]');
  });

  it('removes mailboxes', () => {
    expect(sanitizeText('failed for reader@example.com'))
      .toBe('failed for [redacted:email]');
  });

  it('removes a token carried in a query string', () => {
    expect(sanitizeText('https://x.test/cb?code=abc&token=secret123'))
      .toContain('token=[redacted]');
  });

  it('leaves an ordinary message alone', () => {
    expect(sanitizeText('plan pro_monthly is not configured'))
      .toBe('plan pro_monthly is not configured');
  });

  it('bounds the length, so one report cannot be a log flood', () => {
    expect(sanitizeText('x'.repeat(10_000)).length).toBe(2_000);
  });
});

describe('the context allowlist', () => {
  it('keeps only the keys on the list', () => {
    const context = sanitizeContext({
      scope: 'billing.checkout',
      planKey: 'pro_monthly',
      // None of these is on the list, and that is the point: a denylist would
      // miss whichever field nobody thought of.
      email: 'reader@example.com',
      userId: '52e7b434-1dca-4636-88ab-ea9bdf063761',
      customerId: 'cus_ABCDEFGHIJKLMN',
      requestBody: '{"card":"4242424242424242"}',
    });
    expect(context).toEqual({ scope: 'billing.checkout', planKey: 'pro_monthly' });
  });

  it('sanitizes even the values it keeps', () => {
    const context = sanitizeContext({ code: 'failed for reader@example.com' });
    expect(context.code).toContain('[redacted:email]');
  });

  it('keeps numbers and booleans as they are', () => {
    expect(sanitizeContext({ attempt: 3, outcome: true })).toEqual({ attempt: 3, outcome: true });
    expect(sanitizeContext({ attempt: Number.NaN }).attempt).toBe('NaN');
  });

  it('drops nulls rather than recording an absence', () => {
    expect(sanitizeContext({ scope: 'x', planKey: null, code: undefined })).toEqual({ scope: 'x' });
  });

  it('handles no context at all', () => {
    expect(sanitizeContext(undefined)).toEqual({});
    expect(sanitizeContext({})).toEqual({});
  });

  it('bounds each value, so an object stringified by mistake is not the report', () => {
    const context = sanitizeContext({ code: 'y'.repeat(500) });
    expect(String(context.code).length).toBe(120);
  });

  it('has no key that could carry an identity or a credential', () => {
    // `planKey` and `featureKey` are product configuration and are allowed on
    // purpose; what must never appear is a field naming a person or a secret.
    const forbidden = [
      'email', 'userId', 'user', 'customerId', 'customer', 'accountId', 'account',
      'name', 'fullName', 'address', 'ip', 'token', 'secret', 'password',
      'apiKey', 'secretKey', 'invoiceId', 'subscriptionId', 'payload', 'body',
    ];
    for (const key of allowedContextKeys) {
      expect(forbidden).not.toContain(key);
    }
  });
});

describe('reducing a thrown value', () => {
  it('keeps the frames and redacts them too', () => {
    const error = new Error('checkout failed for sk_live_ABCDEFGHIJKLMNOP');
    const sanitized = sanitizeError(error);
    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toBe('checkout failed for [redacted:provider-key]');
    expect(sanitized.stack).not.toContain('sk_live_');
  });

  it('bounds a deep async stack to its useful head', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 60 }, (_, i) => `    at frame${i}`)].join('\n');
    expect(sanitizeError(error).stack!.split('\n').length).toBe(12);
  });

  it('survives a thrown non-error', () => {
    expect(sanitizeError('a string with reader@example.com').message).toContain('[redacted:email]');
    expect(sanitizeError(null).name).toBe('NonError');
    expect(sanitizeError({ nested: { secret: 'x' } }).message).toBe('[object Object]');
    expect(sanitizeError(undefined).stack).toBeNull();
  });
});
