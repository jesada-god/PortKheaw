import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';
import { AUTH_ENTRY_PATHS, getSafeReturnPath } from '@/src/lib/auth/paths';

/**
 * `/auth/login` and `/auth/register` are the spellings people type; the forms
 * live at `/auth/sign-in` and `/auth/sign-up`. A 404 on the typed spelling
 * looks exactly like a sign-in page that lost its Google button, which is the
 * confusion these aliases exist to remove.
 */
async function rules() {
  if (!nextConfig.redirects) throw new Error('no redirects configured');
  return nextConfig.redirects();
}

describe('auth route aliases', () => {
  it('forwards /auth/login to the real sign-in page', async () => {
    const rule = (await rules()).find((entry) => entry.source === '/auth/login');
    expect(rule?.destination).toBe('/auth/sign-in');
  });

  it('forwards /auth/register to the real sign-up page', async () => {
    const rule = (await rules()).find((entry) => entry.source === '/auth/register');
    expect(rule?.destination).toBe('/auth/sign-up');
  });

  /**
   * A 308 is cached by browsers more or less forever. If these paths ever grow
   * into real pages, a permanent redirect would keep sending returning visitors
   * away from them with no way to take it back.
   */
  it('keeps the aliases reversible rather than permanently cached', async () => {
    for (const rule of await rules()) {
      expect(rule.permanent).toBe(false);
    }
  });

  it('only ever points at destinations on this origin', async () => {
    for (const rule of await rules()) {
      expect(rule.destination.startsWith('/')).toBe(true);
      expect(rule.destination.startsWith('//')).toBe(false);
    }
  });

  /**
   * The alias hands its query string to the destination untouched, so the alias
   * itself must not be usable as a return path — otherwise `?next=/auth/login`
   * would bounce a visitor between the two forever.
   */
  it('cannot be used as a return path, so the alias cannot build a loop', () => {
    expect(getSafeReturnPath('/auth/login')).toBe('/');
    expect(getSafeReturnPath('/auth/register')).toBe('/');
  });

  it('lists every alias as an auth entry path', async () => {
    for (const rule of await rules()) {
      expect(AUTH_ENTRY_PATHS).toContain(rule.source);
    }
  });
});
