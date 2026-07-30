import { describe, expect, it } from 'vitest';
import {
  AUTH_FORM_PATHS,
  PROTECTED_PATHS,
  getSafeReturnPath,
  isAuthEntryPath,
  isAuthFormPath,
  isAuthShellPath,
  isProtectedPath,
} from './paths';

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

describe('auth route classification', () => {
  it('renders every /auth page on the standalone shell', () => {
    for (const path of ['/auth', '/auth/welcome', '/auth/sign-in', '/auth/reset-password', '/auth/callback']) {
      expect(isAuthShellPath(path)).toBe(true);
    }
    for (const path of ['/', '/portfolio', '/authors', '/stock/AAPL']) {
      expect(isAuthShellPath(path)).toBe(false);
    }
  });

  /*
   * The distinction that keeps password recovery working: a signed-in visitor is
   * bounced off the sign-in *forms*, but never off the callback (which must be
   * allowed to spend its code) and never off the reset form (which runs on a
   * live recovery session by design).
   */
  it('bounces signed-in visitors off the forms but not off the callback or the reset page', () => {
    for (const path of AUTH_FORM_PATHS) expect(isAuthFormPath(path)).toBe(true);
    expect(isAuthFormPath('/auth/callback')).toBe(false);
    expect(isAuthFormPath('/auth/reset-password')).toBe(false);
    expect(isAuthFormPath('/auth/check-email')).toBe(false);
  });

  it('treats the callback as an entry path so it is never a return destination', () => {
    expect(isAuthEntryPath('/auth/callback')).toBe(true);
    expect(isAuthEntryPath('/auth/reset-password')).toBe(false);
  });
});

describe('getSafeReturnPath', () => {
  it('keeps a same-origin path with its query and fragment intact', () => {
    expect(getSafeReturnPath('/portfolio')).toBe('/portfolio');
    expect(getSafeReturnPath('/stock/AAPL?tab=options#chart')).toBe('/stock/AAPL?tab=options#chart');
  });

  it('refuses every shape of off-site redirect', () => {
    for (const hostile of [
      'https://evil.com',
      'http://evil.com/path',
      '//evil.com',
      '///evil.com',
      '\\\\evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.com/@portkheaw',
      'mailto:someone@example.com',
    ]) {
      expect(getSafeReturnPath(hostile)).toBe('/');
    }
  });

  it('refuses control characters used to smuggle a scheme past a prefix check', () => {
    expect(getSafeReturnPath('/\nhttps://evil.com')).toBe('/');
    expect(getSafeReturnPath('/\thttps://evil.com')).toBe('/');
    expect(getSafeReturnPath('/portfolio')).toBe('/');
  });

  it('does not decode a percent-encoded off-site payload back into one', () => {
    // Must stay an encoded path segment on this origin, never become //evil.com.
    const encoded = getSafeReturnPath('/%2F%2Fevil.com');
    expect(new URL(encoded, 'https://portkheaw.app').origin).toBe('https://portkheaw.app');
    expect(new URL(getSafeReturnPath('/%5C%5Cevil.com'), 'https://portkheaw.app').origin).toBe('https://portkheaw.app');
  });

  it('refuses to return to a page that would start the login again (no redirect loop)', () => {
    expect(getSafeReturnPath('/auth/sign-in')).toBe('/');
    expect(getSafeReturnPath('/auth/sign-in?next=/auth/sign-in')).toBe('/');
    expect(getSafeReturnPath('/auth/welcome')).toBe('/');
    expect(getSafeReturnPath('/auth/callback?code=abc')).toBe('/');
  });

  it('refuses the /auth/login and /auth/register aliases too, which forward to those pages', () => {
    expect(getSafeReturnPath('/auth/login')).toBe('/');
    expect(getSafeReturnPath('/auth/register')).toBe('/');
    expect(getSafeReturnPath('/auth/login?next=/auth/login')).toBe('/');
  });

  it('still allows the recovery destination, which is not an entry page', () => {
    expect(getSafeReturnPath('/auth/reset-password')).toBe('/auth/reset-password');
  });

  it('falls back to the dashboard for anything that is not a string path', () => {
    for (const value of [null, undefined, '', 'portfolio', 42 as unknown as string]) {
      expect(getSafeReturnPath(value as never)).toBe('/');
    }
  });
});
