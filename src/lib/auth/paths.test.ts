import { describe, expect, it } from 'vitest';
import { isProtectedPath, PROTECTED_PATHS } from './paths';

/**
 * The middleware auth gate keys off {@link isProtectedPath}. These guards lock in
 * that the public market-data routes (quotes, candles, etc.) are NEVER treated as
 * protected — so a same-origin quote request can never be turned into an auth
 * redirect/403 — while the genuinely private areas stay protected.
 */
describe('isProtectedPath', () => {
  it('never protects public market-data routes (quote/candles/history/options)', () => {
    for (const path of [
      '/api/market/quote/RKLB',
      '/api/market/quote/AAPL',
      '/api/market/candles',
      '/api/market/history/intraday',
      '/api/market/options/chain',
      '/api/analytics/analyst-target/RKLB',
    ]) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });

  it('keeps the private areas protected (exact and nested paths)', () => {
    for (const base of PROTECTED_PATHS) {
      expect(isProtectedPath(base)).toBe(true);
      expect(isProtectedPath(`${base}/nested/child`)).toBe(true);
    }
  });

  it('does not protect a route that merely shares a prefix segment with a private one', () => {
    // `/portfolios-public` must not be caught by the `/portfolio` rule.
    expect(isProtectedPath('/portfolio-insights')).toBe(false);
    expect(isProtectedPath('/settings-help')).toBe(false);
  });
});
