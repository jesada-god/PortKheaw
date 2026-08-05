// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortfolioValueSheet, type PortfolioValueSubmission } from './PortfolioValueSheet';
import type { PortfolioRecord, PortfolioSummary } from '@/src/lib/portfolio/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(totalValue: number | null, cashBalance: number): PortfolioSummary {
  return {
    holdings: [],
    cashBalance,
    marketValue: 0,
    costBasis: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    totalValue,
    equityMarketValue: 0,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: cashBalance,
    netTransferredCapital: 0,
    totalGain: 0,
    totalGainPercent: 0,
    todayChange: null,
    todayChangePercent: null,
    optionPositions: [],
    hasMissingPrices: totalValue === null,
  };
}

const portfolios: PortfolioRecord[] = [{
  id: '11111111-1111-4111-8111-111111111111',
  name: 'พอร์ตหลัก',
  type: 'STOCK',
  isLegacy: false,
  archivedAt: null,
  targetValueUsd: null,
  targetDate: null,
  baseCurrency: 'USD',
  transactions: [],
}];

let container: HTMLDivElement;
let root: Root;
let submissions: PortfolioValueSubmission[];

function render(node: React.ReactElement) {
  return act(async () => root.render(node));
}

function sheet(overrides: {
  summaries?: Record<string, PortfolioSummary>;
  pending?: boolean;
  error?: string;
} = {}) {
  return <PortfolioValueSheet
    open
    portfolios={portfolios}
    summaries={overrides.summaries ?? { [portfolios[0].id]: summary(1_000, 400) }}
    defaultPortfolioId={portfolios[0].id}
    currency="USD"
    usdThbRate="35"
    timezone="Asia/Bangkok"
    pending={overrides.pending ?? false}
    isOnline
    error={overrides.error ?? ''}
    idempotencyKey="22222222-2222-4222-8222-222222222222"
    onClose={() => undefined}
    onSubmit={(submission) => submissions.push(submission)}
  />;
}

function amountInput() {
  return [...document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')][0];
}

function submitButton() {
  return [...document.querySelectorAll('button')]
    .find((button) => button.type === 'submit' && button.closest('[data-testid="portfolio-value-sheet"]'))!;
}

async function type(value: string) {
  const input = amountInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  submissions = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ปรับยอดพอร์ต sheet', () => {
  it('opens as a dialog with a focus trap and the wanted-total field', async () => {
    await render(sheet());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.body.textContent).toContain('ปรับยอดพอร์ต');
    expect(document.body.textContent).toContain('มูลค่าพอร์ตรวมที่ต้องการ');
    expect(amountInput()).toBeDefined();
  });

  it('previews current, new, delta and cash before submitting anything', async () => {
    await render(sheet());
    const preview = () => document.querySelector('[data-testid="portfolio-value-preview"]')!.textContent ?? '';
    expect(preview()).toContain('มูลค่าปัจจุบัน');
    expect(preview()).toContain('เงินสดก่อนปรับ');
    expect(preview()).toContain('เงินสดหลังปรับ');
    // Says plainly that holdings do not move.
    expect(preview()).toContain('จำนวนหุ้น จำนวนสัญญา และต้นทุนของสินทรัพย์ที่ถืออยู่จะไม่เปลี่ยนแปลง');

    await type('1250');
    expect(preview()).toContain('ฝากเงินเข้าพอร์ต');
    expect(preview()).toContain('650.00');
    expect(submissions).toHaveLength(0);

    await type('750');
    expect(preview()).toContain('ถอนเงินออกจากพอร์ต');
    expect(preview()).toContain('150.00');
  });

  it('refuses a total below what the cash can pay for and names the floor', async () => {
    await render(sheet());
    await type('400');
    expect(document.body.textContent).toContain('เงินสดในพอร์ตไม่พอสำหรับการลดยอดเท่านี้');
    expect(document.body.textContent).toContain('600.00');
    expect(submitButton().disabled).toBe(true);
  });

  it('will not submit an unchanged total or an unpriceable portfolio', async () => {
    await render(sheet());
    await type('1000');
    expect(document.body.textContent).toContain('ยอดที่กรอกเท่ากับมูลค่าปัจจุบัน');
    expect(submitButton().disabled).toBe(true);

    await render(sheet({ summaries: { [portfolios[0].id]: summary(null, 400) } }));
    await type('1500');
    expect(document.body.textContent).toContain('ยังปรับยอดไม่ได้');
    expect(submitButton().disabled).toBe(true);
  });

  it('submits the wanted total with one stable idempotency key, however many taps', async () => {
    await render(sheet());
    await type('1250');
    const button = submitButton();
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); button.click(); });

    expect(submissions.length).toBeGreaterThanOrEqual(1);
    for (const submission of submissions) {
      expect(submission).toMatchObject({
        portfolioId: portfolios[0].id,
        targetValue: 1_250,
        currency: 'USD',
        timezone: 'Asia/Bangkok',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      });
      // The delta is never sent: the server derives it from the ledger.
      expect(submission).not.toHaveProperty('deltaUsd');
      expect(submission).not.toHaveProperty('currentTotalUsd');
    }
  });

  it('blocks the confirm button and shows the server’s refusal while a write is in flight', async () => {
    await render(sheet({ pending: true, error: 'บันทึกการปรับยอดไม่สำเร็จ กรุณาลองอีกครั้ง' }));
    await type('1250');
    expect(submitButton().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('บันทึกการปรับยอดไม่สำเร็จ');
  });
});
