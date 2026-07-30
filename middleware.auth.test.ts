import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The routing half of the session story: who gets sent where, and — just as
 * important — who does *not* get sent anywhere.
 *
 * The Supabase SSR client is replaced with one that answers `getUser` from a
 * variable, so each case can describe a signed-in or signed-out visitor without
 * a network or a real token.
 */
let currentUser: { id: string } | null = null;

vi.mock('@/src/config/env/client', () => ({
  isSupabaseConfigured: true,
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

let middleware: typeof import('./middleware').middleware;

beforeEach(async () => {
  vi.resetModules();
  currentUser = null;
  ({ middleware } = await import('./middleware'));
});

afterEach(() => {
  currentUser = null;
});

function get(path: string, options: { signedIn?: boolean; sessionCookie?: boolean } = {}) {
  currentUser = options.signedIn ? { id: 'user-1' } : null;
  const request = new NextRequest(`https://portkheaw.app${path}`);
  if (options.sessionCookie) request.cookies.set('sb-project-auth-token', 'stale');
  return middleware(request);
}

function locationOf(response: Response): URL | null {
  const location = response.headers.get('location');
  return location ? new URL(location, 'https://portkheaw.app') : null;
}

describe('protected routes', () => {
  it('sends a signed-out visitor to sign-in carrying the path they wanted', async () => {
    const location = locationOf(await get('/portfolio'))!;
    expect(location.pathname).toBe('/auth/sign-in');
    expect(location.searchParams.get('next')).toBe('/portfolio');
  });

  it('distinguishes an expired session from never having signed in', async () => {
    const expired = locationOf(await get('/watchlist', { sessionCookie: true }))!;
    expect(expired.searchParams.get('reason')).toBe('session_expired');
    const anonymous = locationOf(await get('/watchlist'))!;
    expect(anonymous.searchParams.get('reason')).toBeNull();
  });

  it('lets a signed-in visitor through to a protected route untouched', async () => {
    expect(locationOf(await get('/portfolio', { signedIn: true }))).toBeNull();
  });

  it('leaves the public market pages alone in both states', async () => {
    for (const path of ['/', '/stock/AAPL', '/search']) {
      expect(locationOf(await get(path))).toBeNull();
      expect(locationOf(await get(path, { signedIn: true }))).toBeNull();
    }
  });
});

describe('auth pages and an existing session', () => {
  it('does not strand a signed-in visitor on a sign-in form', async () => {
    for (const path of ['/auth', '/auth/welcome', '/auth/sign-in', '/auth/sign-up', '/auth/forgot-password']) {
      const location = locationOf(await get(path, { signedIn: true }));
      expect(`${path} -> ${location?.pathname}`).not.toBe(`${path} -> ${path}`);
      expect(location).not.toBeNull();
    }
  });

  it('returns them to the path they were originally sent away from', async () => {
    const location = locationOf(await get('/auth/sign-in?next=%2Fportfolio', { signedIn: true }))!;
    expect(location.pathname).toBe('/portfolio');
  });

  /*
   * The loop this rule could create: bounce to `next`, where `next` is the page
   * that bounces. `getSafeReturnPath` refuses to return an entry path, so the
   * destination is always somewhere that will not bounce again.
   */
  it('cannot be made to redirect into itself by a crafted next parameter', async () => {
    for (const next of ['%2Fauth%2Fsign-in', '%2Fauth%2Fwelcome', '%2Fauth%2Fcallback']) {
      const location = locationOf(await get(`/auth/sign-in?next=${next}`, { signedIn: true }))!;
      expect(location.pathname).toBe('/');
    }
  });

  it('never redirects a signed-in visitor off this origin', async () => {
    const location = locationOf(await get('/auth/sign-in?next=https%3A%2F%2Fevil.com', { signedIn: true }))!;
    expect(location.origin).toBe('https://portkheaw.app');
  });

  /*
   * The two exceptions that keep recovery working. The callback must be allowed
   * to spend its code even for a visitor who is already signed in, and the reset
   * form runs on a recovery session — which is a session.
   */
  it('never bounces the callback or the reset form, even with a session present', async () => {
    for (const path of ['/auth/callback?code=abc', '/auth/reset-password']) {
      expect(locationOf(await get(path, { signedIn: true }))).toBeNull();
    }
  });

  it('leaves the auth pages alone for a signed-out visitor', async () => {
    for (const path of ['/auth/welcome', '/auth/sign-in', '/auth/sign-up', '/auth/forgot-password', '/auth/reset-password']) {
      expect(locationOf(await get(path))).toBeNull();
    }
  });
});

describe('security headers on the auth pages', () => {
  it('applies the policy to redirects as well as to rendered pages', async () => {
    const redirected = await get('/portfolio');
    expect(redirected.headers.get('Content-Security-Policy')).toContain(`default-src 'self'`);
    const rendered = await get('/auth/sign-in');
    expect(rendered.headers.get('Content-Security-Policy')).toContain(`frame-ancestors 'none'`);
    expect(rendered.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('allows the browser to talk to Supabase, or sign-in cannot work at all', async () => {
    const response = await get('/auth/sign-in');
    expect(response.headers.get('Content-Security-Policy')).toContain('https://project.supabase.co');
  });
});
