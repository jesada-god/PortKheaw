import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import {
  RATE_LIMITS, clientAddressFrom, consumeRateLimit, rateLimitBucketKey, rateLimitMessage,
  rateLimitScopes,
} from './rate-limit';

type Client = SupabaseClient<Database>;

function fakeClient(rpc: ReturnType<typeof vi.fn>): Client {
  return { rpc } as unknown as Client;
}

describe('the client address, behind a proxy', () => {
  it('takes the first hop, which is the one the platform appended', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' });
    expect(clientAddressFrom(headers)).toBe('203.0.113.7');
  });

  it('tolerates the whitespace real proxies emit', () => {
    expect(clientAddressFrom(new Headers({ 'x-forwarded-for': '  203.0.113.7 ,10.0.0.1' })))
      .toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to nothing', () => {
    expect(clientAddressFrom(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientAddressFrom(new Headers())).toBeNull();
    expect(clientAddressFrom(new Headers({ 'x-forwarded-for': '' }))).toBeNull();
  });
});

describe('the bucket key', () => {
  it('is a digest — the inputs never reach the table', () => {
    const key = rateLimitBucketKey({ scope: 'checkout.start', userId: 'user-123' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('user-123');
    expect(key).not.toContain('checkout');
  });

  it('never mixes two scopes, two accounts or two addresses', () => {
    const a = rateLimitBucketKey({ scope: 'checkout.start', userId: 'u1' });
    const b = rateLimitBucketKey({ scope: 'billing.portal', userId: 'u1' });
    const c = rateLimitBucketKey({ scope: 'checkout.start', userId: 'u2' });
    const d = rateLimitBucketKey({ scope: 'checkout.start', clientAddress: '203.0.113.7' });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('prefers the account over the address, so one NAT is not one bucket', () => {
    const withBoth = rateLimitBucketKey({ scope: 'checkout.start', userId: 'u1', clientAddress: '203.0.113.7' });
    const withUser = rateLimitBucketKey({ scope: 'checkout.start', userId: 'u1' });
    expect(withBoth).toBe(withUser);
  });

  it('pools callers with no identity at all', () => {
    const a = rateLimitBucketKey({ scope: 'support.ticket' });
    const b = rateLimitBucketKey({ scope: 'support.ticket', userId: null, clientAddress: null });
    expect(a).toBe(b);
  });

  it('produces a key the database will accept', () => {
    // The routine refuses a key outside 16..128 characters.
    for (const scope of rateLimitScopes) {
      const key = rateLimitBucketKey({ scope, userId: 'u1' });
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
    }
  });
});

describe('the bounds', () => {
  it('covers every scope the product limits', () => {
    for (const scope of rateLimitScopes) {
      expect(RATE_LIMITS[scope].limit).toBeGreaterThan(0);
      expect(RATE_LIMITS[scope].windowSeconds).toBeGreaterThan(0);
    }
  });

  it('keeps the money paths tighter than the read paths', () => {
    // Each checkout creates an object at the provider; a search does not.
    expect(RATE_LIMITS['checkout.start'].limit).toBeLessThan(RATE_LIMITS['admin.search'].limit);
  });

  it('has no scope for the inbound webhook', () => {
    // Deliberate: bounding provider retries drops paid invoices on the floor.
    expect(rateLimitScopes.some((scope) => scope.includes('webhook'))).toBe(false);
  });
});

describe('consuming a unit', () => {
  it('passes the policy’s own bound, never the caller’s', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, remaining: 7, retry_after_seconds: 0 }], error: null,
    });
    const result = await consumeRateLimit(fakeClient(rpc), { scope: 'checkout.start', userId: 'u1' });

    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      input_bucket_key: rateLimitBucketKey({ scope: 'checkout.start', userId: 'u1' }),
      input_limit: RATE_LIMITS['checkout.start'].limit,
      input_window_seconds: RATE_LIMITS['checkout.start'].windowSeconds,
    });
    expect(result).toEqual({ allowed: true, remaining: 7, retryAfterSeconds: 0, unavailable: false });
  });

  it('reports a refusal the database made', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, remaining: 0, retry_after_seconds: 42 }], error: null,
    });
    const result = await consumeRateLimit(fakeClient(rpc), { scope: 'admin.mutation', userId: 'u1' });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it('fails open when the limiter itself cannot be reached', async () => {
    // A limiter that cannot be consulted must not close checkout. The
    // authorization gates are separate and are what actually protect the action.
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
      vi.fn().mockResolvedValue({ data: [], error: null }),
      vi.fn().mockRejectedValue(new Error('network')),
    ]) {
      const result = await consumeRateLimit(fakeClient(rpc), { scope: 'checkout.start', userId: 'u1' });
      expect(result.allowed).toBe(true);
      expect(result.unavailable).toBe(true);
    }
  });

  it('fails open with no client at all', async () => {
    const result = await consumeRateLimit(null, { scope: 'checkout.start', userId: 'u1' });
    expect(result).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0, unavailable: true });
  });
});

describe('what a reader is told', () => {
  it('never names the bound', () => {
    for (const seconds of [1, 30, 60, 300, 3_600]) {
      const message = rateLimitMessage(seconds);
      expect(message).not.toMatch(/\b(8|10|20|40|60|120)\s*(ครั้ง|requests)/);
      expect(message).toContain('ลองใหม่');
    }
  });

  it('rounds a short wait up to a usable instruction', () => {
    expect(rateLimitMessage(1)).toContain('รอสักครู่');
    expect(rateLimitMessage(300)).toContain('5 นาที');
  });
});
