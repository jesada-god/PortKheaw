// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The option position, as a beginner meets it.
 *
 * Three things were wrong on the shipped build and all three are asserted here.
 * The actions were English trading verbs a first-time holder could not tell
 * apart. `Exercise` and `Expired` reopened "เพิ่มรายการออปชัน" — sixteen fields
 * asking the reader to retype the very contract they had just clicked. And
 * `Expired` was pressable months before the contract expired, with only the
 * ledger's own constraint standing behind it.
 *
 * The fourth test is the one that keeps the rest honest: the simulator is not a
 * transaction, and it must not sit in the row that writes to the ledger.
 */

const push = vi.fn();
const refresh = vi.fn();
const addToast = vi.fn();
const requestUpgrade = vi.fn();
const settleOptionPositionAction = vi.fn();
const createPortfolioTransactionAction = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/app/portfolio/actions', () => ({
  createPortfolioTransactionAction: (...args: unknown[]) => createPortfolioTransactionAction(...args),
  deletePortfolioTransactionAction: vi.fn(),
  updatePortfolioTransactionAction: vi.fn(),
}));

vi.mock('@/app/portfolio/target-actions', () => ({
  deleteOptionTargetAction: vi.fn(),
  upsertOptionTargetAction: vi.fn(),
}));

vi.mock('@/app/portfolio/option-settlement-actions', () => ({
  settleOptionPositionAction: (...args: unknown[]) => settleOptionPositionAction(...args),
}));

vi.mock('@/src/components/ui/Toast', () => ({
  useToast: () => ({ addToast }),
  Toaster: () => null,
}));

vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  useEntitlement: () => ({ can: () => true, requestUpgrade }),
}));

import { OptionsSection } from './OptionsSection';
import type { OptionPositionSummary } from '@/src/lib/portfolio/options/types';
import type { PortfolioRecord } from '@/src/lib/portfolio/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PORTFOLIO_ID = '22222222-2222-4222-8222-222222222222';

const portfolio: PortfolioRecord = {
  id: PORTFOLIO_ID,
  name: 'พอร์ตออปชัน',
  type: 'OPTION',
  isLegacy: false,
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  targetValueUsd: null,
  targetDate: null,
  baseCurrency: 'USD',
  transactions: [],
};

/* The position from the production report: one ASTS $73 Put, and no ASTS shares. */
function position(overrides: Partial<OptionPositionSummary> = {}): OptionPositionSummary {
  return {
    key: 'ASTS260828P00073000',
    underlyingSymbol: 'ASTS',
    contractSymbol: 'ASTS260828P00073000',
    marketContractSymbol: 'ASTS260828P00073000',
    optionKind: 'put',
    side: 'long',
    strikePrice: 73,
    expirationDate: '2026-08-28',
    contracts: 1,
    multiplier: 100,
    averagePremium: 4.25,
    remainingCost: 425,
    realizedGain: 0,
    bid: 5, ask: 5.2, mark: 5.1,
    estimatedClosePrice: 5,
    marketValue: 510,
    estimatedCloseValue: 500,
    todayChange: null,
    todayChangeAsOf: null,
    todayChangeSource: null,
    unrealizedGain: 85,
    unrealizedGainPercent: 20,
    underlyingPrice: 60.5,
    breakeven: 68.75,
    dte: 14,
    impliedVolatility: 0.82,
    delta: -0.4,
    theta: -0.02,
    status: 'open',
    quoteSource: 'alpaca',
    quoteAsOf: '2026-08-14T12:00:00.000Z',
    quoteFreshness: 'delayed',
    transactions: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render({
  marketDate = '2026-08-14',
  positions = [position()],
  sharesBySymbol = {} as Record<string, number>,
  cash = 20_000,
} = {}) {
  await act(async () => {
    root.render(<OptionsSection
      portfolio={portfolio}
      portfolios={[portfolio]}
      positions={positions}
      targets={[]}
      cashByPortfolioId={{ [PORTFOLIO_ID]: cash }}
      sharesBySymbol={sharesBySymbol}
      marketDate={marketDate}
      currency="USD"
      usdThbRate={null}
      showBalances
      isOnline
      timezone="Asia/Bangkok"
    />);
  });
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('Nothing to click');
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const one = (selector: string) => document.body.querySelector(selector);
const all = (selector: string) => [...document.body.querySelectorAll(selector)];
const text = () => document.body.textContent ?? '';

/*
 * The first open position starts expanded, so its actions are already on screen
 * — clicking the card header here would close it.
 */
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('the option action row', () => {
  it('names every action in Thai a beginner can read', async () => {
    await render();
    const labels = all('[data-testid="option-transaction-actions"] button').map((node) => node.textContent?.trim());
    expect(labels).toEqual(['ซื้อเพิ่ม', 'ขายปิดสถานะ', 'ใช้สิทธิ์', 'หมดอายุ']);
    // The English terms survive as tooltips for readers who already know them.
    expect(one('[data-testid="option-action-exercise"]')?.getAttribute('title'))
      .toBe('ใช้สิทธิ์ตามราคา Strike ของสัญญา (Exercise)');
    expect(one('[data-testid="option-action-sell_to_close"]')?.getAttribute('title'))
      .toBe('ขายสัญญาที่ถืออยู่เพื่อปิดสถานะ (Sell to Close)');
  });

  /*
   * The simulator writes nothing. Keeping it out of the transaction row is what
   * stops a reader who meant to try a scenario from recording a trade.
   */
  it('keeps the simulator out of the row that writes to the ledger', async () => {
    await render();
    const transactionRow = one('[data-testid="option-transaction-actions"]');
    expect(transactionRow).not.toBeNull();
    expect(transactionRow?.textContent).not.toContain('จำลองสถานการณ์');
    expect(one('[data-testid="position-tool-option"]')?.textContent).toContain('จำลองสถานการณ์');
  });
});

describe('หมดอายุ before the contract has expired', () => {
  it('cannot be pressed, and says when it will be usable', async () => {
    await render({ marketDate: '2026-08-27' });
    expect((one('[data-testid="option-action-expired"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain('ใช้ได้เมื่อถึงวันหมดอายุ');
  });

  it('opens once the exchange has reached the expiration day', async () => {
    await render({ marketDate: '2026-08-28' });
    expect((one('[data-testid="option-action-expired"]') as HTMLButtonElement).disabled).toBe(false);
    click(one('[data-testid="option-action-expired"]'));
    expect(one('[data-testid="option-settlement-form-expired"]')).not.toBeNull();
    expect(text()).toContain('บันทึกสัญญาหมดอายุ');
    // A long contract still in the money is flagged — and nothing is exercised
    // on the reader's behalf.
    expect(one('[data-testid="option-settlement-itm-warning"]')).not.toBeNull();
    expect(text()).toContain('ไม่มีเงินสดเข้าหรือออกจากรายการนี้');
  });
});

describe('ใช้สิทธิ์', () => {
  it('confirms over the position instead of reopening the add-option form', async () => {
    await render({ sharesBySymbol: { ASTS: 100 } });
    click(one('[data-testid="option-action-exercise"]'));

    expect(one('[data-testid="option-settlement-form-exercise"]')).not.toBeNull();
    expect(one('[data-testid="option-transaction-form"]')).toBeNull();
    expect(text()).toContain('ใช้สิทธิ์ออปชัน');
    // The contract identity is shown, never asked for.
    expect(one('[data-testid="option-settlement-summary"]')?.textContent).toContain('ASTS PUT $73');
    expect(one('[data-testid="option-settlement-summary"]')?.textContent).toContain('100 หุ้น/สัญญา');
    for (const label of ['ราคาใช้สิทธิ (Strike)', 'วันหมดอายุ (Expiration)', 'ตัวคูณต่อสัญญา (Multiplier)']) {
      expect(text()).not.toContain(label);
    }
  });

  it('previews the shares and the cash before anything is written', async () => {
    await render({ sharesBySymbol: { ASTS: 100 } });
    click(one('[data-testid="option-action-exercise"]'));
    const preview = one('[data-testid="option-settlement-preview"]')?.textContent ?? '';
    expect(preview).toContain('คุณจะขาย ASTS 100 หุ้นที่ $73');
    expect(preview).toContain('เงินสดจะเพิ่มขึ้นประมาณ');
    expect(preview).toContain('$7,300.00');
  });

  /* The production bug: no ASTS shares, and $7,300 must not be conjured. */
  it('refuses a Put exercise with no shares to deliver, and offers no confirm', async () => {
    await render({ sharesBySymbol: {} });
    click(one('[data-testid="option-action-exercise"]'));
    expect(text()).toContain('มีหุ้น ASTS ไม่เพียงพอสำหรับใช้สิทธิ์ Put นี้');
    expect(one('[data-testid="option-settlement-preview"]')).toBeNull();
    expect((one('[data-testid="option-settlement-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a Call exercise the cash cannot cover', async () => {
    await render({ positions: [position({ optionKind: 'call', underlyingPrice: 90 })], cash: 1_000 });
    click(one('[data-testid="option-action-exercise"]'));
    expect(text()).toContain('เงินสดในพอร์ตไม่เพียงพอสำหรับใช้สิทธิ์ Call นี้');
    expect((one('[data-testid="option-settlement-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends only the position and the amount — never a contract the reader retyped', async () => {
    settleOptionPositionAction.mockResolvedValue({ ok: true, plan: {} });
    await render({ sharesBySymbol: { ASTS: 100 } });
    click(one('[data-testid="option-action-exercise"]'));
    await act(async () => {
      one('[data-testid="option-settlement-form-exercise"]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(settleOptionPositionAction).toHaveBeenCalledTimes(1);
    const [request] = settleOptionPositionAction.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      portfolioId: PORTFOLIO_ID,
      positionKey: 'ASTS260828P00073000',
      action: 'exercise',
      contracts: 1,
      timezone: 'Asia/Bangkok',
    });
    expect(request).not.toHaveProperty('strikePrice');
    expect(request).not.toHaveProperty('price');
    expect(request).not.toHaveProperty('multiplier');
    expect(createPortfolioTransactionAction).not.toHaveBeenCalled();
  });

  it('refuses more contracts than are open, before the server is asked', async () => {
    await render({ positions: [position({ contracts: 2 })], sharesBySymbol: { ASTS: 500 } });
    click(one('[data-testid="option-action-exercise"]'));
    const input = one('[data-testid="option-settlement-contracts"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text()).toContain('จำนวนสัญญาต้องไม่เกินจำนวนที่ถืออยู่');
    expect((one('[data-testid="option-settlement-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
