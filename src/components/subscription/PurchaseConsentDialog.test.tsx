// @vitest-environment jsdom

/**
 * The consent step, as a control.
 *
 * The properties being pinned are the ones that decide whether the checkbox is
 * meaningful: it starts unticked on every press, the confirm button is closed
 * until it is ticked, and confirming sends the versions the page was rendered
 * with rather than anything the dialog decided for itself.
 *
 * Nothing here can start a checkout: the server action is a mock, and the tests
 * assert both that it is not called before the box is ticked and exactly what it
 * is called with afterwards.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PURCHASE_CONSENT_LABEL,
  currentPurchasePolicyVersions,
} from '@/src/lib/billing/purchase-consent';
import { billingPlans, formatBillingBaht } from '@/src/lib/billing/billing-plans';
import { CheckoutButton } from './CheckoutButton';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

const mocks = vi.hoisted(() => ({ startCheckoutAction: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/app/settings/subscription/billing-actions', () => ({
  startCheckoutAction: mocks.startCheckoutAction,
}));

const VERSIONS = currentPurchasePolicyVersions();

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <CheckoutButton
        planKey="elite_annual_founder"
        paymentMethod="card"
        label="สมัคร Elite รายปี"
        policyVersions={VERSIONS}
      />,
    );
  });
}

const find = (selector: string) => document.body.querySelector(selector);
const click = (node: Element | null) => act(() => {
  node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

/**
 * Tick the box the way a reader does.
 *
 * A native click, not an assignment to `.checked`: React listens for the click
 * on a checkbox and derives `onChange` from it, so setting the property by hand
 * changes the DOM and leaves the component's state behind.
 */
const tickTheBox = () => click(find('[data-testid="purchase-consent-checkbox"]'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startCheckoutAction.mockResolvedValue({ ok: false, code: 'UNAVAILABLE', message: 'ลองใหม่' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('pressing Subscribe', () => {
  it('opens the consent step rather than a checkout', () => {
    expect(find('[data-testid="purchase-consent-dialog"]')).toBeNull();
    expect(mocks.startCheckoutAction).not.toHaveBeenCalled();

    click(find('[data-testid="checkout-button"]'));
    expect(find('[data-testid="purchase-consent-dialog"]')).not.toBeNull();
    expect(mocks.startCheckoutAction).not.toHaveBeenCalled();
  });

  it('shows the plan, the price, the cadence and the rail before confirming', () => {
    click(find('[data-testid="checkout-button"]'));
    const summary = find('[data-testid="purchase-consent-summary"]')?.textContent ?? '';
    expect(summary).toContain(billingPlans.elite_annual_founder.name);
    expect(summary).toContain(formatBillingBaht(billingPlans.elite_annual_founder.firstPeriodBaht));
    // A Founder purchase states what the *second* year costs, too.
    expect(summary).toContain(formatBillingBaht(billingPlans.elite_annual.renewalBaht));
    expect(summary).toContain('รายปี');
    expect(summary).toContain('บัตรเครดิต/เดบิต');

    const body = find('[data-testid="purchase-consent-dialog"]')?.textContent ?? '';
    expect(body).toContain('บัตรจะถูกเรียกเก็บอัตโนมัติทุกปี');
    expect(body).toContain('ภายใน 7 วัน');
    expect(body).toContain('กฎหมายที่ใช้บังคับ');
    expect(body).toContain(PURCHASE_CONSENT_LABEL);
  });

  it('links to both policies it pins the acceptance to', () => {
    click(find('[data-testid="checkout-button"]'));
    const hrefs = [...document.body.querySelectorAll('[data-testid="purchase-consent-dialog"] a')]
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/subscription-policy', '/refund-policy']);
  });
});

describe('the checkbox', () => {
  it('starts unticked and holds the confirm button closed', () => {
    click(find('[data-testid="checkout-button"]'));
    const box = find('[data-testid="purchase-consent-checkbox"]') as HTMLInputElement;
    const confirm = find('[data-testid="purchase-consent-confirm"]') as HTMLButtonElement;
    expect(box.checked).toBe(false);
    expect(confirm.disabled).toBe(true);

    click(confirm);
    expect(mocks.startCheckoutAction).not.toHaveBeenCalled();
  });

  /*
   * The box is a control, not a remembered preference. Dismissing and reopening
   * has to ask again — otherwise a reader consents once and every later purchase
   * inherits it.
   */
  it('is unticked again after the dialog is dismissed and reopened', () => {
    click(find('[data-testid="checkout-button"]'));
    const box = () => find('[data-testid="purchase-consent-checkbox"]') as HTMLInputElement;
    tickTheBox();
    expect(box().checked).toBe(true);
    expect((find('[data-testid="purchase-consent-confirm"]') as HTMLButtonElement).disabled).toBe(false);

    click(find('[aria-label="ปิดหน้าต่าง"]'));
    expect(find('[data-testid="purchase-consent-dialog"]')).toBeNull();

    click(find('[data-testid="checkout-button"]'));
    expect(box().checked).toBe(false);
    expect((find('[data-testid="purchase-consent-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the plan, the rail and the rendered versions once ticked', async () => {
    click(find('[data-testid="checkout-button"]'));
    tickTheBox();

    await act(async () => {
      find('[data-testid="purchase-consent-confirm"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.startCheckoutAction).toHaveBeenCalledWith(
      'elite_annual_founder',
      'card',
      {
        accepted: true,
        subscriptionPolicyVersion: VERSIONS.subscriptionPolicy,
        refundPolicyVersion: VERSIONS.refundPolicy,
      },
    );
  });

  it('shows the server’s refusal without closing the step', async () => {
    mocks.startCheckoutAction.mockResolvedValue({
      ok: false, code: 'CONSENT_STALE', message: 'กรุณารีเฟรชหน้านี้',
    });
    click(find('[data-testid="checkout-button"]'));
    tickTheBox();
    await act(async () => {
      find('[data-testid="purchase-consent-confirm"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(find('[data-testid="purchase-consent-error"]')?.textContent).toContain('กรุณารีเฟรชหน้านี้');
    expect(find('[data-testid="purchase-consent-dialog"]')).not.toBeNull();
  });
});

/**
 * 320×720 and 390×844. The dialog itself is width-capped by `ResponsiveDialog`;
 * what has to hold here is that its contents wrap rather than widen it.
 */
describe('at 320px and 390px', () => {
  it('lets every row and note wrap instead of scrolling sideways', () => {
    click(find('[data-testid="checkout-button"]'));
    const dialog = find('[data-testid="purchase-consent-dialog"]')!;
    expect(dialog.className).toContain('min-w-0');
    expect(dialog.querySelector('[class*="overflow-x-auto"]')).toBeNull();

    for (const row of dialog.querySelectorAll('dl > div')) {
      expect(row.className).toContain('flex-wrap');
      expect(row.querySelector('dd')?.className).toContain('break-words');
    }
    for (const note of dialog.querySelectorAll('ul > li')) {
      expect(note.className).toContain('break-words');
    }
    // The two actions stack on a narrow screen and sit side by side above it.
    const actions = dialog.querySelector('div.flex.min-w-0.flex-col');
    expect(actions?.className).toContain('sm:flex-row-reverse');
  });
});
