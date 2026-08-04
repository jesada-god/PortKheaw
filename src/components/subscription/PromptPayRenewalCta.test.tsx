/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openPromptPayRenewalAction: vi.fn() }));
vi.mock('@/app/settings/subscription/billing-actions', () => ({
  openPromptPayRenewalAction: mocks.openPromptPayRenewalAction,
}));

import { PromptPayRenewalCta } from './PromptPayRenewalCta';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('PromptPay renewal CTA', () => {
  it('opens the existing pending QR with the required label', () => {
    const html = renderToStaticMarkup(
      <PromptPayRenewalCta
        hasOpenInvoice
        hostedInvoiceUrl="https://invoice.stripe.test/i/one"
        canRequestRenewal={false}
      />,
    );
    expect(html).toContain('เปิด QR เพื่อชำระ');
    expect(html).toContain('https://invoice.stripe.test/i/one');
  });

  it('shows a disabled next-period CTA when safe advance payment is unavailable', () => {
    const html = renderToStaticMarkup(
      <PromptPayRenewalCta
        hasOpenInvoice={false}
        hostedInvoiceUrl={null}
        canRequestRenewal={false}
      />,
    );
    expect(html).toContain('ชำระรอบถัดไป');
    expect(html).toContain('ชำระได้เมื่อใกล้หมดอายุ');
    expect(html).toContain('disabled');
  });

  it('latches concurrent clicks before React commits pending state', async () => {
    let finish: ((value: { ok: false; code: 'UNAVAILABLE'; message: string }) => void) | undefined;
    mocks.openPromptPayRenewalAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(
      <PromptPayRenewalCta
        hasOpenInvoice={false}
        hostedInvoiceUrl={null}
        canRequestRenewal
      />,
    ));

    const button = container.querySelector('button')!;
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.openPromptPayRenewalAction).toHaveBeenCalledTimes(1);

    await act(async () => finish?.({ ok: false, code: 'UNAVAILABLE', message: 'ลองใหม่' }));
    expect(container.textContent).toContain('ลองใหม่');
  });
});
