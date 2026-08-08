// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveAccountAccess,
  type AdminPreviewMode,
  type UserRole,
} from '@/src/lib/subscription/admin-access';
import { hasCapability, requiredTierFor } from '@/src/lib/subscription/capabilities';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';
import type { SubscriptionRecord } from '@/src/lib/subscription/subscription-types';
import { themeBootstrap } from './bootstrap';
import { isThemeAvailable, themeRegistry } from './registry';
import { readThemePreference, THEME_STORAGE_KEY, writeThemePreference } from './storage';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { PREMIUM_THEMES, resolveTheme, themeIds, type ThemeId } from './types';

/**
 * The paid-theme contract, end to end.
 *
 * Two things are being proved here, and they are different. The first is that
 * "may this reader use a paid theme?" is answered by the *effective access tier*
 * — the same resolver a trial, an expiry and an administrator preview already
 * move together — rather than by a second, parallel notion of who has paid. The
 * second is that the answer is applied everywhere a theme can be chosen or
 * restored: the pre-paint script, the provider on mount, and the setter. A gate
 * that only holds in the UI is not a gate, because localStorage belongs to the
 * reader.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-08-09T12:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

type Stored = Pick<SubscriptionRecord, 'tier' | 'status' | 'trialEndsAt' | 'currentPeriodEnd'>;

/** The one path from a stored subscription to "may they have a paid theme?". */
function premiumAllowedFor(
  subscription: Stored | null,
  options: { role?: UserRole; previewMode?: AdminPreviewMode; previewExpiresAt?: string | null } = {},
): boolean {
  const access = resolveAccountAccess({
    role: options.role ?? 'user',
    subscriptionEffectiveTier: resolveEffectiveTier(subscription, NOW),
    previewMode: options.previewMode ?? 'actual',
    previewExpiresAt: options.previewExpiresAt ?? null,
    now: NOW,
  });
  return hasCapability(access.effectiveAccessTier, 'theme.premium');
}

const SUBSCRIPTIONS = {
  basic: { tier: 'basic', status: 'basic', trialEndsAt: null, currentPeriodEnd: null },
  pro: { tier: 'pro', status: 'active', trialEndsAt: null, currentPeriodEnd: FUTURE },
  elite: { tier: 'elite', status: 'active', trialEndsAt: null, currentPeriodEnd: FUTURE },
  activeTrial: { tier: 'elite', status: 'trialing', trialEndsAt: FUTURE, currentPeriodEnd: null },
  expiredTrial: { tier: 'elite', status: 'trialing', trialEndsAt: PAST, currentPeriodEnd: null },
  expiredPro: { tier: 'pro', status: 'active', trialEndsAt: null, currentPeriodEnd: PAST },
  canceledElite: { tier: 'elite', status: 'canceled', trialEndsAt: null, currentPeriodEnd: FUTURE },
} as const satisfies Record<string, Stored>;

describe('who may use the paid themes', () => {
  it('asks the entitlement matrix, at the Pro rung, rather than a second tier list', () => {
    expect(requiredTierFor('theme.premium')).toBe('pro');
    expect(hasCapability('basic', 'theme.premium')).toBe(false);
    expect(hasCapability('pro', 'theme.premium')).toBe(true);
    expect(hasCapability('elite', 'theme.premium')).toBe(true);
  });

  it.each([
    ['Pro subscriber', SUBSCRIPTIONS.pro, true],
    ['Elite subscriber', SUBSCRIPTIONS.elite, true],
    ['active Elite trial', SUBSCRIPTIONS.activeTrial, true],
    ['Basic', SUBSCRIPTIONS.basic, false],
    ['expired trial', SUBSCRIPTIONS.expiredTrial, false],
    ['lapsed Pro', SUBSCRIPTIONS.expiredPro, false],
    ['canceled Elite', SUBSCRIPTIONS.canceledElite, false],
    ['no subscription row', null, false],
  ] as const)('%s', (_label, subscription, expected) => {
    expect(premiumAllowedFor(subscription)).toBe(expected);
  });

  it('follows an administrator preview instead of the stored Basic plan', () => {
    const asAdmin = (previewMode: AdminPreviewMode) => premiumAllowedFor(SUBSCRIPTIONS.basic, {
      role: 'admin',
      previewMode,
      previewExpiresAt: FUTURE,
    });
    expect(asAdmin('pro')).toBe(true);
    expect(asAdmin('elite_trial')).toBe(true);
    expect(asAdmin('basic')).toBe(false);
    expect(asAdmin('expired_trial')).toBe(false);
  });

  it('gives a reader who is not an administrator no route in through a stored preview', () => {
    expect(premiumAllowedFor(SUBSCRIPTIONS.basic, { previewMode: 'elite', previewExpiresAt: FUTURE }))
      .toBe(false);
  });
});

describe('resolving a requested theme against the entitlement', () => {
  it('defaults to PortKheaw and keeps it available to everyone', () => {
    expect(resolveTheme(undefined, false)).toBe('portkheaw');
    expect(resolveTheme('portkheaw', false)).toBe('portkheaw');
    expect(isThemeAvailable('portkheaw', false)).toBe(true);
  });

  it('refuses anything it does not recognise, entitled or not', () => {
    for (const allowed of [true, false]) {
      expect(resolveTheme('sepia', allowed)).toBe('portkheaw');
      expect(resolveTheme('', allowed)).toBe('portkheaw');
      expect(resolveTheme(null, allowed)).toBe('portkheaw');
      expect(resolveTheme({ theme: 'bitswap' }, allowed)).toBe('portkheaw');
      expect(resolveTheme(7, allowed)).toBe('portkheaw');
    }
  });

  it('opens the paid themes only with the entitlement, and falls closed without it', () => {
    for (const theme of PREMIUM_THEMES) {
      expect(resolveTheme(theme, true)).toBe(theme);
      expect(resolveTheme(theme, false)).toBe('portkheaw');
      expect(isThemeAvailable(theme, false)).toBe(false);
    }
  });

  it('marks exactly the paid themes as premium in the registry', () => {
    expect(themeIds).toEqual(['portkheaw', 'bitswap', 'dokturek']);
    for (const id of themeIds) {
      expect(themeRegistry[id].premium).toBe((PREMIUM_THEMES as readonly string[]).includes(id));
    }
  });
});

describe('every theme covers every appearance', () => {
  it.each(themeIds)('%s defines a full light and dark palette', (theme) => {
    const dark = readFileSync(resolve(`src/themes/${theme}/dark.css`), 'utf8');
    const light = readFileSync(resolve(`src/themes/${theme}/light.css`), 'utf8');
    expect(dark).toContain(`html[data-theme="${theme}"][data-appearance="dark"]`);
    expect(light).toContain(`html[data-theme="${theme}"][data-appearance="light"]`);
    // The pre-script state must never be token-less, in any theme.
    expect(dark).toContain(`html[data-theme="${theme}"]:not([data-appearance])`);

    // Every token PortKheaw defines exists here too, or the theme would inherit
    // nothing for it — the palettes are theme-scoped, so there is no fallback.
    const names = (css: string) => new Set(
      [...css.matchAll(/^\s{2}(--[a-z-]+):/gm)].map(([, name]) => name),
    );
    const reference = names(readFileSync(resolve('src/themes/portkheaw/dark.css'), 'utf8'));
    for (const appearance of [dark, light]) {
      const defined = names(appearance);
      expect([...reference].filter((token) => !defined.has(token))).toEqual([]);
    }
  });

  it('imports every palette from the one stylesheet entry point', () => {
    const globals = readFileSync(resolve('app/globals.css'), 'utf8');
    for (const theme of themeIds) {
      expect(globals).toContain(`src/themes/${theme}/dark.css`);
      expect(globals).toContain(`src/themes/${theme}/light.css`);
    }
  });
});

describe('the stored preference', () => {
  it('keeps theme and appearance as two independent values', () => {
    const values: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => { values[key] = value; },
    };

    writeThemePreference(storage, { theme: 'dokturek', appearance: 'light' });
    expect(readThemePreference(storage)).toEqual({ theme: 'dokturek', appearance: 'light' });

    writeThemePreference(storage, { theme: 'portkheaw', appearance: 'light' });
    expect(readThemePreference(storage).appearance).toBe('light');
  });

  it('reads a forged theme back verbatim — the gate is applied on use, not on read', () => {
    const storage = {
      getItem: () => JSON.stringify({ theme: 'bitswap', appearance: 'dark' }),
      setItem: () => undefined,
    };
    expect(readThemePreference(storage).theme).toBe('bitswap');
    expect(resolveTheme(readThemePreference(storage).theme, false)).toBe('portkheaw');
  });
});

describe('the pre-paint script', () => {
  it('bakes the server answer in so no premium theme can paint before it is checked', () => {
    expect(themeBootstrap(false)).toContain('P=false');
    expect(themeBootstrap(true)).toContain('P=true');
    for (const script of [themeBootstrap(true), themeBootstrap(false)]) {
      expect(script).not.toContain('setItem');
    }
  });
});

describe('ThemeProvider applies the gate on mount and on change', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  /** Hands the context's setter to the test, the way the settings UI holds it. */
  const probe = {
    theme: 'portkheaw' as ThemeId,
    setTheme: (_theme: ThemeId) => undefined as void,
  };

  function Probe() {
    const { theme, setTheme } = useTheme();
    probe.theme = theme;
    probe.setTheme = setTheme;
    return <p>app</p>;
  }

  function mockMatchMedia(prefersDark: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
      matches: prefersDark,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList));
  }

  async function render(premiumThemesAllowed: boolean) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ThemeProvider premiumThemesAllowed={premiumThemesAllowed}><p>app</p></ThemeProvider>);
    });
  }

  async function rerender(premiumThemesAllowed: boolean) {
    await act(async () => {
      root!.render(<ThemeProvider premiumThemesAllowed={premiumThemesAllowed}><p>app</p></ThemeProvider>);
    });
  }

  const stored = () => JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-appearance');
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('restores a paid theme for an entitled reader, in the appearance they chose', async () => {
    mockMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: 'bitswap', appearance: 'dark' }));

    await render(true);

    expect(document.documentElement.dataset.theme).toBe('bitswap');
    expect(document.documentElement.dataset.appearance).toBe('dark');
    expect(stored()).toEqual({ theme: 'bitswap', appearance: 'dark' });
  });

  it('resolves system against the OS for a paid theme exactly as it does for PortKheaw', async () => {
    mockMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: 'dokturek', appearance: 'system' }));

    await render(true);

    expect(document.documentElement.dataset.theme).toBe('dokturek');
    expect(document.documentElement.dataset.appearance).toBe('dark');
    // `system` is persisted as the preference, never as the dark it resolved to.
    expect(stored()).toEqual({ theme: 'dokturek', appearance: 'system' });
  });

  it('falls a forged paid theme back to PortKheaw and rewrites the stored value', async () => {
    mockMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: 'bitswap', appearance: 'light' }));

    await render(false);

    expect(document.documentElement.dataset.theme).toBe('portkheaw');
    // The appearance the reader chose is untouched by an entitlement decision.
    expect(document.documentElement.dataset.appearance).toBe('light');
    expect(stored()).toEqual({ theme: 'portkheaw', appearance: 'light' });
  });

  it('drops the paid theme the moment entitlement is lost, keeping light/dark as it was', async () => {
    mockMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: 'dokturek', appearance: 'dark' }));

    await render(true);
    expect(document.documentElement.dataset.theme).toBe('dokturek');

    await rerender(false);

    expect(document.documentElement.dataset.theme).toBe('portkheaw');
    expect(document.documentElement.dataset.appearance).toBe('dark');
    // Persisted, so a hard reload or a new session cannot bring it back either.
    expect(stored()).toEqual({ theme: 'portkheaw', appearance: 'dark' });
  });

  it('refuses a paid theme asked for by a caller without the entitlement', async () => {
    mockMatchMedia(false);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ThemeProvider premiumThemesAllowed={false}>
          <Probe />
        </ThemeProvider>,
      );
    });

    // The setter is reachable from the settings UI; it must refuse rather than
    // trust its caller, and must not leave a paid theme in storage.
    await act(async () => probe.setTheme('bitswap'));

    expect(probe.theme).toBe('portkheaw');
    expect(document.documentElement.dataset.theme).toBe('portkheaw');
    expect(stored()).toEqual({ theme: 'portkheaw', appearance: 'system' });
  });

  it('lets an entitled reader switch between all three themes', async () => {
    mockMatchMedia(false);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ThemeProvider premiumThemesAllowed>
          <Probe />
        </ThemeProvider>,
      );
    });

    for (const theme of themeIds) {
      await act(async () => probe.setTheme(theme));
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(stored()).toEqual({ theme, appearance: 'system' });
      // Switching a theme never disturbs the light/dark preference.
      expect(document.documentElement.dataset.appearance).toBe('light');
    }
  });
});
