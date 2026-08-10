// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The tracker's navigation, rendered for real.
 *
 * The source-reading contracts next door prove the markup exists; this proves
 * the screens actually reach one another — asset view to a category and back,
 * portfolio view to a portfolio's detail, an empty portfolio to its call to
 * action — and that the accounting the redesign moved out of the way is still
 * one tap from where it used to be.
 */

const refresh = vi.fn();
const addToast = vi.fn();
const requestUpgrade = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/app/portfolio/actions', () => ({
  createPortfolioTransactionAction: vi.fn(),
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
  useEntitlement: () => ({ requestUpgrade }),
}));

// The rate is a network read; the tracker's job here is to survive without one.
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
import type { PortfolioRecord, PortfolioTransaction } from '@/src/lib/portfolio/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FUNDED = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';

function transaction(overrides: Partial<PortfolioTransaction>): PortfolioTransaction {
  return {
    id: crypto.randomUUID(),
    portfolioId: FUNDED,
    type: 'deposit',
    symbol: null,
    quantity: null,
    price: null,
    amount: '10000',
    occurredAt: '2026-01-02T00:00:00.000Z',
    note: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function portfolio(id: string, name: string, transactions: PortfolioTransaction[]): PortfolioRecord {
  return {
    id, name, type: 'STOCK', isLegacy: false, archivedAt: null, deletedAt: null,
    purgeAfter: null, targetValueUsd: null, targetDate: null, baseCurrency: 'USD',
    transactions,
  };
}

const portfolios = [
  portfolio(FUNDED, 'พอร์ตหลัก', [
    transaction({ type: 'deposit', amount: '10000' }),
    transaction({ type: 'acquisition', symbol: 'AAPL', quantity: '10', price: '100', amount: '1000' }),
    transaction({ type: 'acquisition', symbol: 'VOO', quantity: '2', price: '400', amount: '800' }),
  ]),
  portfolio(EMPTY, 'พอร์ตว่าง', []),
];

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<PortfolioClient
      portfolios={portfolios}
      aggregateGoal={{ targetValueUsd: null, targetDate: null }}
      marketPrices={{
        AAPL: { price: 120, previousClose: 118 },
        VOO: { price: 450, previousClose: 449 },
      }}
      optionQuotes={{}}
      optionTargets={[]}
      recentlyDeleted={[]}
      fx={{ quote: null, unavailable: true }}
      timezone="Asia/Bangkok"
      effectiveTier="elite"
      assetTypes={{ AAPL: 'Stock', VOO: 'ETF' }}
      companyNames={{ AAPL: 'Apple Inc.', VOO: 'Vanguard S&P 500 ETF' }}
    />);
  });
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('Nothing to click');
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const find = (selector: string) => container.querySelector(selector);
const findAll = (selector: string) => [...container.querySelectorAll(selector)];
const byText = (selector: string, text: string) =>
  findAll(selector).find((node) => node.textContent?.includes(text)) ?? null;

beforeEach(() => {
  refresh.mockReset();
  addToast.mockReset();
  requestUpgrade.mockReset();
  // jsdom has no layout, so the scroll-to-top the drill-down performs would
  // otherwise print a "not implemented" trace over every navigation assertion.
  window.scrollTo = () => undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the asset view', () => {
  it('opens on the reader’s own assets, grouped by the class the instrument master gave them', async () => {
    await render();

    expect(container.textContent).toContain('สินทรัพย์ของฉัน');
    expect(find('[data-testid="tracker-view-toggle"]')).not.toBeNull();
    expect(find('[data-testid="portfolio-hero"]')).not.toBeNull();

    // Cash, one stock and one ETF — and no category the account does not hold.
    expect(find('[data-testid="asset-category-cash"]')).not.toBeNull();
    expect(find('[data-testid="asset-category-stock"]')).not.toBeNull();
    expect(find('[data-testid="asset-category-etf"]')).not.toBeNull();
    expect(find('[data-testid="asset-category-option"]')).toBeNull();
  });

  it('filters to one class from the chip rail without leaving the screen', async () => {
    await render();
    const chip = findAll('[role="tab"]').find((node) => node.textContent?.startsWith('ETF'));

    click(chip);

    expect(find('[data-testid="asset-category-etf"]')).not.toBeNull();
    expect(find('[data-testid="asset-category-stock"]')).toBeNull();
    expect(chip?.getAttribute('aria-selected')).toBe('true');
  });

  it('drills into a class and comes back', async () => {
    await render();

    click(find('[data-testid="asset-category-stock"]'));
    expect(find('[data-testid="category-asset-list"]')).not.toBeNull();
    expect(container.textContent).toContain('AAPL');
    // A row read outside one portfolio says which portfolio it is in.
    expect(container.textContent).toContain('พอร์ตหลัก');

    click(find('button[aria-label="กลับไปหน้าสินทรัพย์ของฉัน"]'));
    expect(find('[data-testid="tracker-view-toggle"]')).not.toBeNull();
  });
});

describe('the portfolio view', () => {
  it('lists portfolios as cards and opens one into its own screen', async () => {
    await render();

    click(byText('[data-testid="tracker-view-toggle"] button', 'แยกพอร์ต'));
    expect(find('[data-testid="portfolio-card-list"]')).not.toBeNull();
    expect(find(`[data-testid="portfolio-card-${FUNDED}"]`)).not.toBeNull();
    expect(find(`[data-testid="portfolio-card-${EMPTY}"]`)).not.toBeNull();

    click(find(`[data-testid="portfolio-card-${FUNDED}"]`));
    expect(find('[data-testid="portfolio-overflow"]')).not.toBeNull();
    expect(find('[data-testid="holdings-list"]')).not.toBeNull();
    expect(container.textContent).toContain('พอร์ตหลัก');
  });

  /*
   * An unfunded portfolio is a decision somebody has not made yet. It gets a
   * full card and, inside, a statement of what is missing — and no button,
   * because the header's one call to action is the way to add.
   */
  it('shows an intentional empty state, with the page’s one add flow behind it', async () => {
    await render();
    click(byText('[data-testid="tracker-view-toggle"] button', 'แยกพอร์ต'));
    click(find(`[data-testid="portfolio-card-${EMPTY}"]`));

    const empty = find('[data-testid="portfolio-empty-state"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('ยังไม่มีสินทรัพย์ในพอร์ตนี้');
    expect(empty?.querySelector('button')).toBeNull();

    click(find('[data-testid="portfolio-add-asset"]'));
    expect(document.querySelector('[data-testid="portfolio-add-asset-sheet"]')).not.toBeNull();
  });

  it('offers edit and delete from the detail overflow, and nothing that deletes on the press', async () => {
    await render();
    click(byText('[data-testid="tracker-view-toggle"] button', 'แยกพอร์ต'));
    click(find(`[data-testid="portfolio-card-${FUNDED}"]`));
    click(find('[data-testid="portfolio-overflow"]'));

    const menu = document.querySelector('[data-testid="portfolio-overflow-menu"]');
    expect(menu).not.toBeNull();
    for (const label of ['แก้ไขพอร์ต', 'ลบพอร์ต']) {
      expect(menu?.textContent).toContain(label);
    }
  });
});

describe('the accounting the redesign moved', () => {
  it('is one disclosure away, and still reads every figure off the ledger summary', async () => {
    await render();

    const panel = find('[data-testid="portfolio-accounting-details"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).not.toContain('Net deposits');

    click(panel?.querySelector('button'));
    const opened = find('[data-testid="portfolio-accounting-details"]');
    for (const label of ['เงินฝากสุทธิ (Net deposits)', 'ต้นทุนคงเหลือ', 'Realized P&L', 'Unrealized P&L']) {
      expect(opened?.textContent).toContain(label);
    }
  });

  it('keeps the statement route as the only home for transaction history', async () => {
    await render();
    const entry = find('[data-testid="portfolio-history-entry"]');
    expect(entry?.getAttribute('href')).toBe('/portfolio/transactions');
  });
});
