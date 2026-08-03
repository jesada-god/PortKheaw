// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The exit button imports the server actions the way a client component does.
 * Next replaces that import with a network reference at build time; in a plain
 * module graph it would pull the server-only resolver in, so it is stubbed. The
 * behaviour under test here is what the banner renders, not what the action does.
 */
vi.mock('@/app/settings/subscription/actions', () => ({
  setAdminAccessPreviewAction: vi.fn(),
  clearAdminAccessPreviewAction: vi.fn(),
}));

import { resolveAccountBadges } from '@/src/lib/subscription/account-badges';
import { adminPreviewModes, type AdminPreviewMode } from '@/src/lib/subscription/admin-access';
import type { PageEntitlement } from '@/src/lib/subscription/page-entitlement';
import { AccountIdentity } from './AccountBadges';
import { AdminPreviewBanner } from './AdminPreviewBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

const LONG_NAME = 'ธนกฤต มหาวงศ์วรรณกุล เจริญรุ่งเรืองทรัพย์ไพศาล';

async function renderIdentity(
  name: string,
  input: Parameters<typeof resolveAccountBadges>[0],
) {
  await act(async () => root.render(
    <AccountIdentity name={name} badges={resolveAccountBadges(input)} />,
  ));
}

function badgeText() {
  return [...document.querySelectorAll('[data-testid="role-badge"], [data-testid="plan-badge"]')]
    .map((node) => node.textContent?.trim());
}

describe('account identity badges', () => {
  it('renders an ordinary reader as a single plan badge with no ADMIN', async () => {
    const cases = [
      { tier: 'basic', status: 'basic', text: 'BASIC' },
      { tier: 'pro', status: 'active', text: 'PRO' },
      { tier: 'elite', status: 'active', text: 'ELITE' },
      { tier: 'elite', status: 'trialing', text: 'ELITE TRIAL' },
    ] as const;

    for (const { tier, status, text } of cases) {
      await renderIdentity('ผู้ใช้ทดสอบ', {
        role: 'user',
        adminPreviewMode: 'actual',
        subscriptionEffectiveTier: tier,
        status,
      });
      expect(document.querySelector('[data-testid="role-badge"]')).toBeNull();
      expect(badgeText()).toEqual([text]);
      expect(document.querySelector('[data-testid="plan-badge"]')?.getAttribute('data-preview')).toBe('false');
    }
  });

  /*
   * `ELITE ACCESS`, not `ELITE`. The administrator below holds a Basic
   * subscription; stamping `ELITE` beside their name would claim they are being
   * billed for a plan they never bought.
   */
  it('renders the administrator as ADMIN then ELITE ACCESS, in that order', async () => {
    await renderIdentity('Jesada Tawinteung', {
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    expect(badgeText()).toEqual(['ADMIN', 'ELITE ACCESS']);
    expect(container.textContent).toContain('Jesada Tawinteung');
    // The grant is its own badge kind, so no surface can confuse it with a
    // purchased Elite plan.
    expect(document.querySelector('[data-testid="plan-badge"]')?.getAttribute('data-plan'))
      .toBe('elite_access');
  });

  it('paints the ADMIN badge from the red role tokens, never a plan tone', async () => {
    await renderIdentity('Jesada Tawinteung', {
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    const role = document.querySelector('[data-testid="role-badge"]')!;
    for (const token of ['--role-admin-bg', '--role-admin-border', '--role-admin-text']) {
      expect(role.className).toContain(token);
    }
    // A plan tone on the operator badge would be the exact confusion the
    // separate token set exists to prevent.
    expect(role.className).not.toMatch(/--plan-/);
  });

  it('renders every preview as ADMIN plus a dashed TEST badge', async () => {
    const expected: Record<Exclude<AdminPreviewMode, 'actual'>, string> = {
      basic: 'BASIC TEST',
      pro: 'PRO TEST',
      elite: 'ELITE TEST',
      elite_trial: 'ELITE TRIAL TEST',
      expired_trial: 'EXPIRED TRIAL TEST',
    };

    for (const [mode, text] of Object.entries(expected)) {
      await renderIdentity('Jesada Tawinteung', {
        role: 'admin',
        adminPreviewMode: mode as AdminPreviewMode,
        subscriptionEffectiveTier: 'basic',
        status: 'basic',
      });
      expect(badgeText()).toEqual(['ADMIN', text]);
      const plan = document.querySelector('[data-testid="plan-badge"]')!;
      expect(plan.getAttribute('data-preview')).toBe('true');
      // A simulation is drawn as an outline, never as a filled chip.
      expect(plan.className).toContain('border-dashed');
      expect(plan.className).not.toContain('color-mix');
    }
  });

  it('takes every badge tone from a theme token so both appearances are covered', async () => {
    await renderIdentity('Jesada Tawinteung', {
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    for (const node of document.querySelectorAll('[data-testid="role-badge"], [data-testid="plan-badge"]')) {
      expect(node.className).toMatch(/var\(--(plan|role)-/);
      // No literal colour anywhere: a hex here would be right in one appearance
      // and wrong in the other.
      expect(node.className).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it('keeps colour from being the only signal', async () => {
    for (const mode of adminPreviewModes) {
      await renderIdentity('Jesada Tawinteung', {
        role: 'admin',
        adminPreviewMode: mode,
        subscriptionEffectiveTier: 'basic',
        status: 'basic',
      });
      const plan = document.querySelector('[data-testid="plan-badge"]')!;
      expect(plan.textContent?.trim().length).toBeGreaterThan(0);
      if (mode !== 'actual') expect(plan.textContent).toContain('TEST');
    }
  });

  it('lets a long name truncate rather than push the row wide', async () => {
    await renderIdentity(LONG_NAME, {
      role: 'admin',
      adminPreviewMode: 'elite_trial',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    const heading = document.querySelector('h2')!;
    expect(heading.className).toContain('truncate');
    expect(heading.className).toContain('min-w-0');
    // The row wraps, so badges drop under the name instead of being squeezed.
    expect(heading.parentElement!.className).toContain('flex-wrap');
    expect(heading.parentElement!.className).toContain('min-w-0');
    // Badges themselves never break mid-label.
    for (const badge of document.querySelectorAll('[data-testid="plan-badge"]')) {
      expect(badge.className).toContain('whitespace-nowrap');
      expect(badge.className).toContain('max-w-full');
    }
  });
});

function entitlement(overrides: Partial<PageEntitlement> = {}): PageEntitlement {
  return {
    effectiveAccessTier: 'elite',
    subscriptionEffectiveTier: 'basic',
    authenticated: true,
    role: 'admin',
    isAdmin: true,
    adminPreviewMode: 'basic',
    previewExpiresAt: '2026-08-03T13:00:00.000Z',
    trialOffer: 'available',
    ...overrides,
  };
}

describe('admin preview banner', () => {
  it('names the running mode and offers the way back', async () => {
    await act(async () => root.render(<AdminPreviewBanner entitlement={entitlement()} />));
    const banner = document.querySelector('[data-testid="admin-preview-banner"]')!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('data-preview-mode')).toBe('basic');
    expect(banner.textContent).toContain('โหมดทดสอบสิทธิ์ Admin');
    expect(banner.textContent).toContain('Basic');
    // The expiry is stated, so an operator knows when access returns on its own.
    expect(banner.textContent).toContain('หมดอายุ');
    expect(document.querySelector('[data-testid="admin-preview-exit"]')?.textContent).toContain('กลับสู่สิทธิ์จริง');
  });

  it('names each simulated plan', async () => {
    const labels: Record<string, string> = {
      pro: 'Pro',
      elite: 'Elite',
      elite_trial: 'Elite Trial',
      expired_trial: 'Trial หมดอายุ',
    };
    for (const [mode, label] of Object.entries(labels)) {
      await act(async () => root.render(
        <AdminPreviewBanner entitlement={entitlement({ adminPreviewMode: mode as AdminPreviewMode })} />,
      ));
      expect(document.querySelector('[data-testid="admin-preview-banner"]')?.textContent).toContain(label);
    }
  });

  it('renders nothing at all for an administrator who is not previewing', async () => {
    await act(async () => root.render(
      <AdminPreviewBanner entitlement={entitlement({ adminPreviewMode: 'actual', previewExpiresAt: null })} />,
    ));
    expect(document.querySelector('[data-testid="admin-preview-banner"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an ordinary reader, even one carrying a stale preview mode', async () => {
    for (const mode of adminPreviewModes) {
      await act(async () => root.render(
        <AdminPreviewBanner entitlement={entitlement({
          role: 'user',
          isAdmin: false,
          adminPreviewMode: mode,
          effectiveAccessTier: 'basic',
        })} />,
      ));
      expect(document.querySelector('[data-testid="admin-preview-banner"]')).toBeNull();
      // Not merely hidden — the markup is never sent.
      expect(container.textContent).toBe('');
    }
  });
});
