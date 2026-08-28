// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * One way to add, two kinds of asset.
 *
 * The page used to offer "เพิ่มรายการออปชัน" beside the options heading, again
 * inside the options empty state, and again inside the portfolio empty state,
 * next to its own header button — four buttons for one intention, and none of
 * them able to add a share to an option portfolio or an option to a stock one.
 *
 * These prove the replacement: exactly one "เพิ่มสินทรัพย์" in the document on
 * every screen, a sheet that routes หุ้น / ETF into the transaction form and
 * ออปชัน into the option form, and both kinds reachable regardless of what the
 * portfolio being read happens to hold. The ledger underneath is untouched, so
 * the last test here watches the action the stock flow submits.
 */

const refresh = vi.fn();
const addToast = vi.fn();
const requestUpgrade = vi.fn();
const createPortfolioTransactionAction = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/app/portfolio/actions', () => ({
  createPortfolioTransactionAction: (...args: unknown[]) => createPortfolioTransactionAction(...args),
  setPortfolioBaseCurrencyAction: vi.fn(),
  deletePortfolioTransactionAction: vi.fn(),
  updatePortfolioTransactionAction: vi.fn(),
}));

vi.mock('@/app/portfolio/reconcile-actions', () => ({
  reconcilePortfolioValueAction: vi.fn(),
}));

vi.mock('@/app/portfolio/portfolio-actions', () => ({
  archivePortfolioAction: vi.fn(),
  createPortfolioAction: vi.fn(),
  resetPortfolioAction: vi.fn(),
  restoreDeletedPortfolioAction: vi.fn(),
  restorePortfolioAction: vi.fn(),
  setPortfolioGoalAction: vi.fn(),
  softDeletePortfolioAction: vi.fn(),
  transferPortfolioCashAction: vi.fn(),
  updatePortfolioAction: vi.fn(),
}));

vi.mock('@/app/portfolio/transfer-actions', () => ({
  confirmAssetTransferAction: vi.fn(),
  loadPortfolioDeletionSummaryAction: vi.fn(),
  loadTransferableAssetsAction: vi.fn(),
  previewAssetTransferAction: vi.fn(),
}));

vi.mock('@/app/portfolio/target-actions', () => ({
  deleteOptionTargetAction: vi.fn(),
  upsertOptionTargetAction: vi.fn(),
}));

vi.mock('@/src/components/ui/Toast', () => ({
  useToast: () => ({ addToast }),
  Toaster: () => null,
}));

vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  // `can` is read by the position tool action these screens now render.
  useEntitlement: () => ({ can: () => true, requestUpgrade }),
}));

vi.mock('@/src/lib/market-data/fx/client', () => ({
  fetchFxRate: () => Promise.resolve({ quote: null, unavailable: true }),
  formatFxRate: (value: string | null) => String(value ?? '—'),
}));

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => React.createElement('img', props),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));

import { PortfolioClient } from './PortfolioClient';
import type { PortfolioRecord, PortfolioTransaction, PortfolioType } from '@/src/lib/portfolio/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STOCK = '11111111-1111-4111-8111-111111111111';
const OPTION = '22222222-2222-4222-8222-222222222222';
const EMPTY_OPTION = '33333333-3333-4333-8333-333333333333';
const LEGACY = '44444444-4444-4444-8444-444444444444';

let sequence = 0;
function transaction(overrides: Partial<PortfolioTransaction>): PortfolioTransaction {
  sequence += 1;
  return {
    id: `tx-${sequence}`,
    portfolioId: STOCK,
    type: 'deposit',
    symbol: null,
    quantity: null,
    price: null,
    amount: '10000',
    occurredAt: '2026-01-02T00:00:00.000Z',
    occurredAtTime: '2026-01-02T00:00:00.000Z',
    note: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function portfolio(id: string, name: string, type: PortfolioType, transactions: PortfolioTransaction[]): PortfolioRecord {
  return {
    id, name, type, isLegacy: false, archivedAt: null, deletedAt: null,
    purgeAfter: null, targetValueUsd: null, targetDate: null, baseCurrency: 'USD',
    transactions,
  };
}

/* A stock-only portfolio and an option-only portfolio: the two shapes the one
   call to action has to work from without inheriting their limits. */
const portfolios = [
  portfolio(STOCK, 'พอร์ตหุ้น', 'STOCK', [
    transaction({ type: 'deposit', amount: '10000' }),
    transaction({ type: 'acquisition', symbol: 'AAPL', quantity: '10', price: '100', amount: '1000' }),
  ]),
  portfolio(OPTION, 'พอร์ตออปชัน', 'OPTION', [
    transaction({ portfolioId: OPTION, type: 'deposit', amount: '5000' }),
    transaction({
      portfolioId: OPTION,
      type: 'buy_to_open',
      quantity: '1',
      price: '2',
      normalizedPriceUsd: '2',
      amount: null,
      fee: '0',
      normalizedFeeUsd: '0',
      underlyingSymbol: 'AAPL',
      contractSymbol: 'AAPL260821C00200000',
      optionKind: 'call',
      optionSide: 'long',
      strikePrice: '200',
      expirationDate: '2026-08-21',
      multiplier: '100',
    }),
  ]),
  /* Funded but holding nothing — the empty states this used to duplicate on. */
  portfolio(EMPTY_OPTION, 'พอร์ตออปชันใหม่', 'OPTION', [
    transaction({ portfolioId: EMPTY_OPTION, type: 'deposit', amount: '1000' }),
  ]),
];

/*
 * The screen from the production bug report, rebuilt exactly.
 *
 * A single "Default / Legacy" portfolio — the one every account is given — with
 * one NVDA position in it and no option anywhere. LEGACY accepts both kinds, so
 * the options section renders, and on the shipped build that section carried the
 * only two add buttons on the whole screen while the call to action lived on a
 * screen the reader had already navigated away from.
 */
const reportedCase = [
  portfolio(LEGACY, 'Default / Legacy', 'LEGACY', [
    transaction({ portfolioId: LEGACY, type: 'deposit', amount: '20000' }),
    transaction({ portfolioId: LEGACY, type: 'acquisition', symbol: 'NVDA', quantity: '5', price: '150', amount: '750' }),
  ]),
];
reportedCase[0].isLegacy = true;

let container: HTMLDivElement;
let root: Root;

async function render(records: PortfolioRecord[] = portfolios) {
  await act(async () => {
    root.render(<PortfolioClient
      portfolios={records}
      aggregateGoal={{ targetValueUsd: null, targetDate: null }}
      marketPrices={{ AAPL: { price: 120, previousClose: 118 }, NVDA: { price: 180, previousClose: 176 } }}
      optionQuotes={{}}
      optionTargets={[]}
      recentlyDeleted={[]}
      fx={{ quote: null, unavailable: true }}
      timezone="Asia/Bangkok"
      marketDate="2026-08-14"
      session="OPEN"
      effectiveTier="elite"
      assetTypes={{ AAPL: 'Stock', NVDA: 'Stock' }}
      companyNames={{ AAPL: 'Apple Inc.', NVDA: 'NVIDIA Corporation' }}
    />);
  });
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('Nothing to click');
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/*
 * Both dialogs render through a portal onto `document.body`, and the count that
 * matters is per document rather than per container — a second call to action
 * inside a portal would be just as duplicated as one in the page.
 */
const inDocument = (selector: string) => [...document.body.querySelectorAll(selector)];
const one = (selector: string) => document.body.querySelector(selector);
const byText = (selector: string, text: string) =>
  inDocument(selector).find((node) => node.textContent?.includes(text)) ?? null;

/*
 * Role-and-name queries, over the whole document because both dialogs portal
 * onto `document.body`. Written against the DOM rather than pulled in from a
 * query library, which this suite does not use anywhere — the semantics are the
 * ones that matter: find a *button* by the *name a reader would hear*, not by a
 * test id that can stay right while the label goes wrong.
 */
const accessibleName = (node: Element) =>
  (node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();

const getAllByRoleButton = (name: RegExp) =>
  [...document.body.querySelectorAll('button')].filter((node) => name.test(accessibleName(node)));

const queryByRoleButton = (name: RegExp) => getAllByRoleButton(name)[0] ?? null;

function openSheet() {
  const ctas = inDocument('[data-testid="portfolio-add-asset"]');
  expect(ctas).toHaveLength(1);
  click(ctas[0]);
}

function openPortfolioDetail(id: string) {
  click(byText('[data-testid="tracker-view-toggle"] button', 'แยกพอร์ต'));
  click(one(`[data-testid="portfolio-card-${id}"]`));
}

beforeEach(() => {
  refresh.mockReset();
  addToast.mockReset();
  requestUpgrade.mockReset();
  createPortfolioTransactionAction.mockReset();
  createPortfolioTransactionAction.mockResolvedValue({ ok: true, symbol: 'AAPL', logoUrl: null });
  window.scrollTo = () => undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the one call to action', () => {
  it('is the only add button on the assets screen, and opens both kinds', async () => {
    await render();

    expect(inDocument('[data-testid="portfolio-add-asset"]')).toHaveLength(1);
    expect(container.textContent).toContain('เพิ่มสินทรัพย์');
    expect(container.textContent).not.toContain('เพิ่มรายการออปชัน');

    openSheet();
    const sheet = one('[data-testid="portfolio-add-asset-sheet"]');
    expect(sheet?.textContent).toContain('หุ้น / ETF');
    expect(sheet?.textContent).toContain('เพิ่มรายการซื้อ ขาย หรือสินทรัพย์ที่ถืออยู่');
    expect(sheet?.textContent).toContain('ออปชัน');
    expect(sheet?.textContent).toContain('เพิ่ม Call / Put position');
  });

  it('stays a single button on a portfolio’s own screen, where the options section used to carry its own', async () => {
    await render();
    openPortfolioDetail(OPTION);

    expect(one('[data-testid="options-position-list"]')).not.toBeNull();
    expect(inDocument('[data-testid="portfolio-add-asset"]')).toHaveLength(1);
    expect(container.textContent).not.toContain('เพิ่มรายการออปชัน');
  });

  it('leaves an empty portfolio with a message and no add button of its own', async () => {
    await render();
    openPortfolioDetail(EMPTY_OPTION);

    const empty = one('[data-testid="portfolio-empty-state"]');
    expect(empty?.textContent).toContain('ยังไม่มีสินทรัพย์ในพอร์ตนี้');
    expect(empty?.querySelector('button')).toBeNull();

    // The options section's own empty state states the fact and offers nothing.
    const emptyOptions = one('[data-testid="options-empty-state"]');
    expect(emptyOptions?.textContent).toContain('ยังไม่มีรายการออปชันใน Ledger');
    expect(emptyOptions?.querySelector('button')).toBeNull();

    expect(inDocument('[data-testid="portfolio-add-asset"]')).toHaveLength(1);
  });
});

describe('choosing a kind', () => {
  it('routes หุ้น / ETF into the existing transaction form', async () => {
    await render();
    openSheet();
    click(one('[data-testid="add-asset-stock"]'));

    expect(one('[data-testid="portfolio-transaction-form"]')).not.toBeNull();
    expect(one('[data-testid="option-transaction-form"]')).toBeNull();
  });

  it('routes ออปชัน into the existing option form', async () => {
    await render();
    openSheet();
    await act(async () => { click(one('[data-testid="add-asset-option"]')); });

    expect(one('[data-testid="option-transaction-form"]')).not.toBeNull();
    expect(one('[data-testid="portfolio-transaction-form"]')).toBeNull();
  });

  /*
   * The point of the redesign: an account reading its stock portfolio can still
   * open an option, and one reading its option portfolio can still open a share.
   * Neither flow is gated on what the portfolio in front of the reader holds.
   */
  it('adds an option from a stock-only portfolio, targeting a portfolio that accepts one', async () => {
    await render();
    openPortfolioDetail(STOCK);
    openSheet();
    await act(async () => { click(one('[data-testid="add-asset-option"]')); });

    const form = one('[data-testid="option-transaction-form"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector('select')).toHaveProperty('value', OPTION);
  });

  it('adds a share from an option-only portfolio, targeting a portfolio that accepts one', async () => {
    await render();
    openPortfolioDetail(OPTION);
    openSheet();
    click(one('[data-testid="add-asset-stock"]'));

    const form = one('[data-testid="portfolio-transaction-form"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector('select')).toHaveProperty('value', STOCK);
  });
});

/*
 * The production regression, pinned.
 *
 * Every assertion here is a measurement that was taken off the live page before
 * the fix: on `portkheaw.vercel.app` at 663299d, this exact screen reported two
 * "เพิ่มรายการออปชัน" buttons and zero "เพิ่มสินทรัพย์", at 1440×900 and at
 * 430×932 alike. They are written by role and accessible name for that reason —
 * the bug was about what a reader could see and press, and a test id would have
 * gone on passing through all of it.
 */
describe('a portfolio holding one stock and no options', () => {
  async function openReportedScreen() {
    await render(reportedCase);
    click(byText('[data-testid="tracker-view-toggle"] button', 'แยกพอร์ต'));
    click(one(`[data-testid="portfolio-card-${LEGACY}"]`));
    expect(one('[data-testid="holdings-list"]')?.textContent).toContain('NVDA');
    expect(one('[data-testid="options-position-list"]')).toBeNull();
  }

  it('shows exactly one “เพิ่มสินทรัพย์” and no “เพิ่มรายการออปชัน”', async () => {
    await openReportedScreen();

    expect(getAllByRoleButton(/เพิ่มสินทรัพย์/)).toHaveLength(1);
    expect(queryByRoleButton(/เพิ่มรายการออปชัน/)).toBeNull();
  });

  it('opens the kind selector from that button', async () => {
    await openReportedScreen();
    click(getAllByRoleButton(/เพิ่มสินทรัพย์/)[0]);

    const sheet = one('[data-testid="portfolio-add-asset-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('หุ้น / ETF');
    expect(sheet?.textContent).toContain('ออปชัน');
  });

  it('reaches the stock transaction form through หุ้น / ETF', async () => {
    await openReportedScreen();
    click(getAllByRoleButton(/เพิ่มสินทรัพย์/)[0]);
    click(one('[data-testid="add-asset-stock"]'));

    const form = one('[data-testid="portfolio-transaction-form"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector('select')).toHaveProperty('value', LEGACY);
  });

  /*
   * The other half of the report: this portfolio holds no option, and adding one
   * must still be possible from it. LEGACY accepts both kinds, so the option
   * flow lands right here rather than anywhere else.
   */
  it('reaches the option form through ออปชัน, without leaving this portfolio', async () => {
    await openReportedScreen();
    click(getAllByRoleButton(/เพิ่มสินทรัพย์/)[0]);
    await act(async () => { click(one('[data-testid="add-asset-option"]')); });

    const form = one('[data-testid="option-transaction-form"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector('select')).toHaveProperty('value', LEGACY);
  });

  it('states the options section is empty without offering a button for it', async () => {
    await openReportedScreen();

    const emptyOptions = one('[data-testid="options-empty-state"]');
    expect(emptyOptions?.textContent).toContain('ยังไม่มีรายการออปชันใน Ledger');
    expect(emptyOptions?.querySelector('button')).toBeNull();
  });
});

describe('the ledger underneath', () => {
  it('still writes one acquisition through the same action, with the same shape', async () => {
    await render();
    openSheet();
    click(one('[data-testid="add-asset-stock"]'));

    const form = one('[data-testid="portfolio-transaction-form"]') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(createPortfolioTransactionAction).toHaveBeenCalledTimes(1);
    expect(createPortfolioTransactionAction.mock.calls[0][0]).toMatchObject({
      portfolioId: STOCK,
      type: 'acquisition',
      timezone: 'Asia/Bangkok',
    });
    expect(refresh).toHaveBeenCalled();
  });
});
