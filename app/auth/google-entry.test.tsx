import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in page and the sign-up page must offer Google on exactly the same
 * terms. They drifted apart once already — the button was reported present on
 * one page and missing on the other — so these tests pin the property that
 * matters: *one* capability source, consulted by *both* pages, deciding a
 * divider and a button that appear and disappear together.
 *
 * The pages are async server components. They are awaited and their returned
 * element tree is inspected directly, which is what lets this run without a DOM
 * or a Next.js server: rendering is not the subject, the conditional is.
 */
// The forms reach the server actions, which pull in the server-only env module.
vi.mock('server-only', () => ({}));

const getEnabledAuthProviders = vi.fn();

vi.mock('@/src/lib/auth/providers', () => ({
  getEnabledAuthProviders: () => getEnabledAuthProviders(),
  NO_EXTERNAL_PROVIDERS: { google: false },
}));

// The pages guard on this before they render any form at all.
vi.mock('@/src/config/env/client', () => ({
  isSupabaseConfigured: true,
  clientEnv: {
    NEXT_PUBLIC_APP_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  },
}));

// Login also server-renders the public aggregate. This fixture stays entirely
// non-identifying and avoids Next's request-bound cookies API in a direct render.
vi.mock('@/src/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { member_count: 1284 }, error: null }),
        }),
      }),
    }),
  }),
}));

const { default: SignInPage } = await import('./sign-in/page');
const { default: SignUpPage } = await import('./sign-up/page');
const { AuthDivider } = await import('@/src/components/auth/AuthControls');
const { SignInForm } = await import('@/src/components/auth/SignInForm');
const { SignUpForm } = await import('@/src/components/auth/SignUpForm');

type Node = ReactElement<Record<string, unknown>>;

function isElement(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** Every element in the tree, so assertions do not depend on nesting depth. */
function flatten(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...flatten(children)];
}

async function renderPage(
  page: (args: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<ReactNode>,
  params: Record<string, string | string[] | undefined> = {},
): Promise<Node[]> {
  return flatten(await page({ searchParams: Promise.resolve(params) }));
}

/**
 * The Google control is loaded through `next/dynamic`, so its element type is a
 * lazy wrapper rather than the component itself. It is identified by the props
 * only it is given — which is also what proves the two pages pass the same
 * shape.
 */
function googleButtons(tree: Node[]): Node[] {
  return tree.filter((node) => typeof node.props.label === 'string' && 'next' in node.props);
}

function dividers(tree: Node[]): Node[] {
  return tree.filter((node) => node.type === AuthDivider);
}

beforeEach(() => {
  getEnabledAuthProviders.mockReset();
});

describe('Google on the sign-in page', () => {
  it('offers the button and the divider when the project has Google enabled', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: true });

    const tree = await renderPage(SignInPage);
    const buttons = googleButtons(tree);

    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.label).toBe('เข้าสู่ระบบด้วย Google');
    expect(dividers(tree)).toHaveLength(1);
  });

  it('hides the button and the divider when Google is switched off', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: false });

    const tree = await renderPage(SignInPage);

    expect(googleButtons(tree)).toHaveLength(0);
    // No orphan "หรือ" separating the form from nothing.
    expect(dividers(tree)).toHaveLength(0);
  });

  it('keeps the email and password form either way, so sign-in never depends on Google', async () => {
    for (const google of [true, false]) {
      getEnabledAuthProviders.mockResolvedValue({ google });
      const tree = await renderPage(SignInPage);
      expect(tree.filter((node) => node.type === SignInForm)).toHaveLength(1);
    }
  });

  it('hands the Google control the sanitised return path, not the raw query value', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: true });

    const tree = await renderPage(SignInPage, { next: '/portfolio?tab=options' });

    expect(googleButtons(tree)[0].props.next).toBe('/portfolio?tab=options');
  });

  it('refuses an off-site return path handed to the Google control', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: true });

    for (const hostile of ['https://evil.example/steal', '//evil.example', '/\\evil.example']) {
      const tree = await renderPage(SignInPage, { next: hostile });
      expect(googleButtons(tree)[0].props.next).toBe('/');
    }
  });
});

describe('sign-in and sign-up parity', () => {
  it('reads the same capability source, so the two pages can never disagree', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: true });

    await renderPage(SignInPage);
    const afterSignIn = getEnabledAuthProviders.mock.calls.length;
    await renderPage(SignUpPage);

    expect(afterSignIn).toBe(1);
    expect(getEnabledAuthProviders).toHaveBeenCalledTimes(2);
  });

  it('shows Google on both pages together, and hides it on both together', async () => {
    for (const google of [true, false]) {
      getEnabledAuthProviders.mockResolvedValue({ google });
      const expected = google ? 1 : 0;

      expect(googleButtons(await renderPage(SignInPage))).toHaveLength(expected);
      expect(googleButtons(await renderPage(SignUpPage))).toHaveLength(expected);
    }
  });

  it('labels each page for what the visitor is actually doing there', async () => {
    getEnabledAuthProviders.mockResolvedValue({ google: true });

    expect(googleButtons(await renderPage(SignInPage))[0].props.label).toBe('เข้าสู่ระบบด้วย Google');
    expect(googleButtons(await renderPage(SignUpPage))[0].props.label).toBe('สร้างบัญชีด้วย Google');
  });

  it('keeps the sign-up form present regardless of Google, mirroring sign-in', async () => {
    for (const google of [true, false]) {
      getEnabledAuthProviders.mockResolvedValue({ google });
      const tree = await renderPage(SignUpPage);
      expect(tree.filter((node) => node.type === SignUpForm)).toHaveLength(1);
    }
  });
});
