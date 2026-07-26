import { describe, expect, it, vi } from 'vitest';
import { withOptionsRouteDiagnostics } from './route-diagnostics';

describe('Options route diagnostics', () => {
  it('distinguishes a Nexora route 429 from an upstream 429 without secrets', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const local = await withOptionsRouteDiagnostics(new Response(JSON.stringify({
      meta: { provider: null, freshness: { status: 'unavailable' } },
    }), { status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' } }), {
      route: 'options-expirations', symbol: 'NVDA', routeRateLimited: true,
    });
    const upstream = await withOptionsRouteDiagnostics(new Response(JSON.stringify({
      meta: { provider: null, freshness: { status: 'unavailable' } },
    }), { status: 429, headers: { 'Retry-After': '45', 'Content-Type': 'application/json' } }), {
      route: 'options-expirations', symbol: 'NVDA', providerHint: 'alpha-vantage',
    });

    expect(local.headers.get('X-Options-Rate-Limit-Source')).toBe('nexora');
    expect(local.headers.get('X-Options-Provider')).toBeNull();
    expect(upstream.headers.get('X-Options-Rate-Limit-Source')).toBe('upstream');
    expect(upstream.headers.get('X-Options-Provider')).toBe('alpha-vantage');
    expect(upstream.headers.get('X-Options-Single-Flight')).toBe('enabled');
    expect(upstream.headers.get('X-Options-Failure-Kind')).toBe('upstream-rate-limit');
  });
});
