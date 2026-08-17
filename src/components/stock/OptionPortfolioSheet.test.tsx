// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionPurchaseQuoteSnapshot } from '@/src/lib/portfolio/options/purchase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const purchase = vi.fn(async (_payload: Record<string, unknown>) => ({
  ok: true as const,
  transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  quote: null as unknown as OptionPurchaseQuoteSnapshot,
  cost: 0,
  fee: 0,
  cashAfter: 0,
}));

vi.mock('@/app/portfolio/option-purchase-actions', () => ({
  loadOptionPurchasePortfoliosAction: async () => ({
    ok: true,
    portfolios: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Options', cashBalance: 1_000 }],
    atLimit: false,
    timezone: 'Asia/Bangkok',
  }),
  purchaseOptionFromChainAction: (payload: Record<string, unknown>) => purchase(payload),
}));
/*
 * These three hand back the same object on every call, exactly as the real
 * providers do. A mock that returned a fresh one would change the identity of a
 * value the portfolio-loading effect depends on, and the sheet would reload its
 * portfolios forever — a defect in the test, not in the component.
 */
vi.mock('next/navigation', () => {
  const router = { refresh: () => undefined };
  return { useRouter: () => router };
});
vi.mock('@/src/components/subscription/EntitlementProvider', () => {
  const entitlement = { requestUpgrade: () => undefined };
  return { useEntitlement: () => entitlement };
});
vi.mock('@/src/components/ui/Toast', () => {
  const toast = { addToast: () => undefined };
  return { useToast: () => toast };
});

const { OptionPortfolioSheet } = await import('./OptionPortfolioSheet');

function quote(): OptionPurchaseQuoteSnapshot {
  return {
    underlyingSymbol: 'AAPL', optionKind: 'call', strike: 200, expiration: '2026-08-21',
    contractSymbol: 'AAPL260821C00200000', multiplier: 100,
    bid: 2.4, ask: 2.5, mid: 2.45, last: 2.45,
    impliedVolatility: 0.31, delta: 0.45, gamma: 0.02, theta: -0.04, vega: 0.12, rho: 0.03,
    spot: 198.5, quoteTimestamp: new Date().toISOString(), chainTimestamp: new Date().toISOString(),
    status: 'delayed', delayedMinutes: 15, provider: 'test', marketDataProvider: 'test-quotes',
  };
}

let container: HTMLDivElement;
let root: Root;

function field(label: string) {
  const wrapper = [...document.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label));
  return wrapper?.querySelector('input') ?? null;
}

function summary() {
  return document.querySelector('[data-testid="option-purchase-summary"]')?.textContent ?? '';
}

function submitButton() {
  return [...document.querySelectorAll('button')].find((button) => button.type === 'submit')!;
}

function modeButton(label: string) {
  return [...document.querySelectorAll('button')].find((button) => button.textContent === label)!;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function open() {
  await act(async () => root.render(<OptionPortfolioSheet quote={quote()} onClose={() => undefined} />));
  // The portfolio list resolves in an effect; the fee box only means something
  // once a portfolio with a cash balance is selected.
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  purchase.mockClear();
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('เพิ่ม Call/Put เข้าพอร์ต sheet', () => {
  it('offers a fee field beside the datetime and starts it at zero', async () => {
    await open();
    const fee = document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!;
    expect(fee.value).toBe('0');
    expect(fee.step).toBe('0.01');
    expect(fee.min).toBe('0');
    expect(document.body.textContent).toContain('ค่าธรรมเนียม (USD)');
    expect(document.body.textContent).toContain('ค่าคอมมิชชัน + ค่าธรรมเนียมทั้งหมดของออเดอร์นี้');
    // Both halves of the row share one two-column grid, so the datetime control
    // is half the width rather than the whole sheet.
    const row = field('วันที่และเวลา')!.closest('div.grid')!;
    expect(row.className).toContain('min-[480px]:grid-cols-2');
    expect(row.contains(fee)).toBe(true);
  });

  it('spends the fee in every figure the summary shows', async () => {
    await open();
    await type(field('จำนวนสัญญา')!, '2');
    await type(document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!, '7.50');
    // 2 x 100 x 2.50 = 500 of premium, plus 7.50 of commission.
    expect(summary()).toContain('$507.50');
    expect(summary()).toContain('$7.50');
    // 1,000 of cash less the whole 507.50.
    expect(summary()).toContain('$492.50');
    // Strike 200 plus 2.50 a share plus 7.50 spread over 200 shares.
    expect(summary()).toContain('$202.5375');
  });

  it('multiplies a per-contract fee out and says what the order will be charged', async () => {
    await open();
    await type(field('จำนวนสัญญา')!, '3');
    await type(document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!, '0.65');
    expect(document.querySelector('[data-testid="option-fee-total"]')).toBeNull();
    await act(async () => { modeButton('ต่อสัญญา').click(); });
    expect(document.querySelector('[data-testid="option-fee-total"]')?.textContent).toContain('$1.95');
    expect(summary()).toContain('$751.95');
  });

  it('refuses to submit a fee that is not a number at or above zero', async () => {
    await open();
    const fee = document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!;
    await type(fee, '-5');
    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain('ค่าธรรมเนียมต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    await type(fee, '5');
    expect(submitButton().disabled).toBe(false);
  });

  it('sends the fee as typed with its mode and offers it again next time', async () => {
    await open();
    await type(document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!, '1.25');
    await act(async () => { modeButton('ต่อสัญญา').click(); });
    await act(async () => { submitButton().click(); });
    expect(purchase).toHaveBeenCalledOnce();
    expect(purchase.mock.calls[0][0]).toMatchObject({ fee: '1.25', feeMode: 'per_contract' });
    expect(window.localStorage.getItem('options_default_fee')).toBe('1.25');

    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    expect(document.querySelector<HTMLInputElement>('[data-testid="option-fee-input"]')!.value).toBe('1.25');
  });
});
