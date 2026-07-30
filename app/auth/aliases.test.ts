import { describe, expect, it, vi } from 'vitest';

/**
 * `/auth/login` and `/auth/register` are the spellings people type; the forms
 * live at `/auth/sign-in` and `/auth/sign-up`. A 404 on the typed spelling is
 * indistinguishable from a broken sign-in page, so both aliases forward.
 *
 * `redirect` throws in Next.js, so it is replaced with a recorder here — the
 * assertion is about the destination that gets built, including the fact that
 * the alias sanitises `next` instead of passing it through.
 */
const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

const { default: LoginAlias } = await import('./login/page');
const { default: RegisterAlias } = await import('./register/page');

async function destinationOf(
  page: (args: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<unknown>,
  params: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  redirect.mockClear();
  await page({ searchParams: Promise.resolve(params) });
  return redirect.mock.calls[0][0] as string;
}

describe('/auth/login', () => {
  it('forwards to the real sign-in page', async () => {
    expect(await destinationOf(LoginAlias)).toBe('/auth/sign-in?next=%2F');
  });

  it('carries a legitimate destination through to the form', async () => {
    const destination = await destinationOf(LoginAlias, { next: '/portfolio' });
    expect(new URL(destination, 'https://portkheaw.app').searchParams.get('next')).toBe('/portfolio');
  });

  it('cannot be used to bounce a visitor off this origin', async () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const destination = await destinationOf(LoginAlias, { next: hostile });
      expect(new URL(destination, 'https://portkheaw.app').searchParams.get('next')).toBe('/');
    }
  });

  it('cannot be pointed back at itself', async () => {
    const destination = await destinationOf(LoginAlias, { next: '/auth/login' });
    expect(new URL(destination, 'https://portkheaw.app').searchParams.get('next')).toBe('/');
  });
});

describe('/auth/register', () => {
  it('forwards to the real sign-up page', async () => {
    expect(await destinationOf(RegisterAlias)).toBe('/auth/sign-up?next=%2F');
  });

  it('sanitises its destination the same way the login alias does', async () => {
    const destination = await destinationOf(RegisterAlias, { next: '//evil.example' });
    expect(new URL(destination, 'https://portkheaw.app').searchParams.get('next')).toBe('/');
  });
});
