// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTUAL_PLAN_HEADING,
  ADMIN_ACCESS_HEADING,
  PREVIEW_ACCESS_HEADING,
  PREVIEW_BILLING_UNCHANGED_NOTE,
  resolveAccountPlanSummary,
} from '@/src/lib/subscription/account-plan-summary';
import type { AdminPreviewMode } from '@/src/lib/subscription/admin-access';
import { AccountPlanSummary } from './AccountPlanSummary';

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

async function render(input: Parameters<typeof resolveAccountPlanSummary>[0]) {
  await act(async () => root.render(
    <AccountPlanSummary summary={resolveAccountPlanSummary(input)} />,
  ));
}

const text = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? null;

/**
 * The profile's central claim: a reader can tell what they are *billed for*
 * apart from what they can *open*. For an administrator those two differ, and
 * before Phase 4 the page merged them and said "Elite" beside an account whose
 * card had never been charged.
 */
describe('account plan summary', () => {
  it.each([
    ['basic', 'basic', 'Basic'],
    ['pro', 'active', 'Pro'],
    ['elite', 'active', 'Elite'],
    ['elite', 'trialing', 'Elite Trial'],
  ] as const)('states an ordinary reader on %s/%s as their real plan alone', async (tier, status, expected) => {
    await render({
      role: 'user',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: tier,
      status,
    });
    expect(text('actual-plan-heading')).toBe(ACTUAL_PLAN_HEADING);
    expect(text('actual-plan-value')).toBe(expected);
    // No second line: their access *is* their plan, so repeating it would only
    // invite the reader to look for a difference that is not there.
    expect(document.querySelector('[data-testid="access-line"]')).toBeNull();
  });

  /*
   * The owner case from the brief: a Basic subscription, Elite access, and the
   * page must not imply the two are the same thing.
   */
  it('states an administrator’s real plan and their operator grant separately', async () => {
    await render({
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    expect(text('actual-plan-heading')).toBe(ACTUAL_PLAN_HEADING);
    expect(text('actual-plan-value')).toBe('Basic');
    expect(text('access-heading')).toBe(ADMIN_ACCESS_HEADING);
    expect(text('access-value')).toBe('Elite — สิทธิ์ผู้ดูแลระบบ');
    expect(document.querySelector('[data-testid="access-line"]')?.getAttribute('data-access-kind'))
      .toBe('admin');
  });

  it('never describes operator access as a purchase', async () => {
    await render({
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    const body = container.textContent ?? '';
    for (const claim of ['ชำระเงิน', 'ต่ออายุ', 'บาท', 'เรียกเก็บ']) {
      expect(body, claim).not.toContain(claim);
    }
  });

  /*
   * While a preview runs, the real plan line must not move — it is the answer to
   * "what am I paying for?", and a simulation does not change that.
   */
  it.each([
    ['basic', 'Basic'],
    ['pro', 'Pro'],
    ['elite', 'Elite'],
    ['elite_trial', 'Elite Trial'],
    ['expired_trial', 'Trial หมดอายุ'],
  ] as const)('labels the %s preview as a simulation over the unchanged real plan', async (mode, label) => {
    await render({
      role: 'admin',
      adminPreviewMode: mode as AdminPreviewMode,
      subscriptionEffectiveTier: 'pro',
      status: 'active',
    });
    // The real plan is the account's own, not the previewed one.
    expect(text('actual-plan-value')).toBe('Pro');
    expect(text('access-heading')).toBe(PREVIEW_ACCESS_HEADING);
    expect(text('access-value')).toBe(`${label} — โหมดทดสอบ Admin`);
    expect(text('access-note')).toBe(PREVIEW_BILLING_UNCHANGED_NOTE);
    expect(document.querySelector('[data-testid="access-line"]')?.getAttribute('data-access-kind'))
      .toBe('preview');
  });

  it('promises billing did not change while a preview is running', async () => {
    await render({
      role: 'admin',
      adminPreviewMode: 'pro',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    expect(text('access-note')).toContain('การเรียกเก็บเงินไม่ได้เปลี่ยน');
  });

  /*
   * A preview mode stored against an account that is not an administrator must
   * never be applied — demoting an account withdraws its simulation.
   */
  it('ignores a preview mode carried by an ordinary reader', async () => {
    await render({
      role: 'user',
      adminPreviewMode: 'elite',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    expect(text('actual-plan-value')).toBe('Basic');
    expect(document.querySelector('[data-testid="access-line"]')).toBeNull();
  });

  /*
   * 320px is the narrowest viewport this product supports. Nothing here may
   * force the page wider than its container.
   */
  it('wraps rather than forcing a horizontal scrollbar at 320px', async () => {
    await render({
      role: 'admin',
      adminPreviewMode: 'expired_trial',
      subscriptionEffectiveTier: 'elite',
      status: 'active',
    });
    for (const node of container.querySelectorAll('div, p, span')) {
      const className = node.className;
      if (typeof className !== 'string') continue;
      expect(className).not.toContain('whitespace-nowrap');
      expect(className).not.toMatch(/\bw-\[\d{3,}px\]/);
    }
    // The long Thai access line is allowed to break inside a word if it must.
    expect(document.querySelector('[data-testid="access-value"]')?.className).toContain('break-words');
    expect(document.querySelector('[data-testid="access-value"]')?.className).toContain('min-w-0');
  });

  it('takes its icon tone from the shared admin token in both appearances', async () => {
    await render({
      role: 'admin',
      adminPreviewMode: 'actual',
      subscriptionEffectiveTier: 'basic',
      status: 'basic',
    });
    const icon = document.querySelector('[data-testid="access-line"] svg');
    expect(icon?.getAttribute('class')).toContain('--role-admin-text');
  });
});
