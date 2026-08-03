// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPaywallEventSink } from '@/src/lib/subscription/paywall-telemetry';
import { EntitlementProvider } from './EntitlementProvider';
import { LockedFeatureButton } from './LockedFeatureButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  setPaywallEventSink(vi.fn());
});

afterEach(async () => {
  await act(async () => root.unmount());
  setPaywallEventSink(null);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('shared entitlement upgrade prompt', () => {
  it('blocks activation, mounts one mobile-safe dialog, closes with Escape, and restores focus', async () => {
    const activateWhatIf = vi.fn();
    const activateVpvr = vi.fn();
    await act(async () => root.render(
      <EntitlementProvider tier="basic" authenticated trialOffer="available">
        <LockedFeatureButton
          capability="simulator.what_if"
          source="test.what-if"
          onActivate={activateWhatIf}
          data-testid="what-if-trigger"
        >
          คำนวณผลลัพธ์
        </LockedFeatureButton>
        <LockedFeatureButton
          capability="chart.vpvr"
          source="test.vpvr"
          onActivate={activateVpvr}
          data-testid="vpvr-trigger"
        >
          VPVR
        </LockedFeatureButton>
      </EntitlementProvider>,
    ));

    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="what-if-trigger"]')!;
    trigger.focus();
    await act(async () => trigger.click());

    expect(activateWhatIf).not.toHaveBeenCalled();
    expect(activateVpvr).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="upgrade-modal"]')).toHaveLength(1);
    expect(trigger.dataset.locked).toBe('true');
    expect(trigger.dataset.requiredTier).toBe('pro');

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.className).toContain('w-[calc(100vw-24px)]');
    expect(dialog.className).toContain('max-h-[min(calc(100dvh-24px),100%)]');
    expect(document.querySelector('[data-testid="upgrade-required-plan"]')?.textContent).toContain('Pro');

    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="upgrade-cta"]')!;
    expect(cta.getAttribute('href')).toBe('/settings/subscription');
    expect(cta.textContent).toContain('ทดลอง Elite ฟรี 7 วัน');
    expect(cta.className).toContain('min-h-11');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('ปิดหน้าต่าง');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('runs an entitled Pro feature without opening the upgrade prompt', async () => {
    const onActivate = vi.fn();
    await act(async () => root.render(
      <EntitlementProvider tier="pro" authenticated trialOffer="used">
        <LockedFeatureButton
          capability="simulator.what_if"
          source="test.what-if-pro"
          onActivate={onActivate}
          data-testid="pro-trigger"
        >
          คำนวณผลลัพธ์
        </LockedFeatureButton>
      </EntitlementProvider>,
    ));

    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="pro-trigger"]')!.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
