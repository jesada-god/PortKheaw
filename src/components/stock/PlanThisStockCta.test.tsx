// @vitest-environment jsdom

/**
 * The Planner card at the foot of Financials.
 *
 * The arithmetic it prints is proved in `src/lib/tools/stock-plan-outlook.test.ts`
 * and its placement in `src/lib/tools/planner-contract.test.ts`. What neither can
 * prove is the wiring this file exists for: that the four figures are the
 * reader's OWN saved plan read back from the route the Planner writes to, that a
 * reader without one is shown em dashes rather than a number borrowed from
 * somewhere else, and that the button still opens the flow it always opened —
 * with the symbol and nothing else — while the wording follows what is on screen.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
const requestUpgrade = vi.fn();
let unlocked = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  useEntitlement: () => ({ can: () => unlocked, requestUpgrade }),
}));

import { PlanThisStockCta } from './PlanThisStockCta';

/** One saved plan, in the shape `GET /api/stock-plans` returns. 20% up, 10% down. */
const SAVED_PLAN = {
  id: 'plan-1', symbol: 'AAPL',
  baselinePrice: 100, targetPrice: 120, invalidationPrice: 90,
  horizonDate: '2027-12-31', createdAt: '2026-08-14T18:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;
let listed: unknown[] = [];
let requests: string[] = [];

function stubPlansRoute() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/stock-plans')) {
      return Promise.resolve(new Response(JSON.stringify({ data: listed }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }));
}

async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function renderCard(assetType = 'stock') {
  await act(async () => {
    root.render(<PlanThisStockCta symbol="AAPL" assetType={assetType} currency="USD" />);
  });
  await settle();
}

function figures(): string[] {
  return [...container.querySelectorAll('[data-testid="stock-detail-plan-figures"] dd')]
    .map((node) => node.textContent ?? '');
}

function cta(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="stock-detail-plan-cta"]');
}

beforeEach(() => {
  unlocked = true;
  listed = [];
  requests = [];
  push.mockReset();
  requestUpgrade.mockReset();
  stubPlansRoute();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('the Planner card on Stock Detail', () => {
  it('names the feature and what it is for, above the figures', async () => {
    await renderCard();
    const section = container.querySelector('[data-testid="stock-detail-plan-section"]')!;
    expect(section.textContent).toContain('วางแผนเข้า–ออกหุ้นตัวนี้');
    expect(section.textContent).toContain('กำหนดราคาเข้า • เป้ากำไร • จุดตัดขาดทุน ก่อนเริ่มเทรด');
    // The four labels are what tells a reader what a plan is, before they make one.
    const labels = [...section.querySelectorAll('dt')].map((node) => node.textContent);
    expect(labels).toEqual(['ราคาเข้า', 'เป้ากำไร', 'Cut Loss', 'Risk/Reward']);
  });

  /*
    The empty state's whole point: nothing is invented to fill it. A quote is not
    an entry, a target or a stop, and printing one under those labels would show
    the reader a decision they have not made.
  */
  it('shows an em dash in every figure until there is a plan to show', async () => {
    await renderCard();
    expect(figures()).toEqual(['—', '—', '—', '—']);
    expect(cta()!.textContent).toContain('สร้างแผน');
    expect(container.querySelector('[data-testid="stock-detail-plan-note"]')).toBeNull();
  });

  it('shows the saved plan for this stock, and offers to edit it', async () => {
    listed = [{ ...SAVED_PLAN, symbol: 'MSFT', id: 'other' }, SAVED_PLAN];
    await renderCard();
    // The ratio is the planner's own evaluation of the stored row: 20% ÷ 10%.
    expect(figures()).toEqual(['$100.00', '$120.00', '$90.00', '1 : 2.0']);
    expect(cta()!.textContent).toContain('แก้ไขแผน');
    expect(container.querySelector('[data-testid="stock-detail-plan-note"]')!.textContent)
      .toContain('2027-12-31');
  });

  it('leaves the figures empty when another stock is the one with a plan', async () => {
    listed = [{ ...SAVED_PLAN, symbol: 'MSFT', id: 'other' }];
    await renderCard();
    expect(figures()).toEqual(['—', '—', '—', '—']);
    expect(cta()!.textContent).toContain('สร้างแผน');
  });

  it('carries the symbol and nothing else into the planner it always opened', async () => {
    await renderCard();
    await act(async () => { cta()!.click(); });
    expect(push).toHaveBeenCalledWith('/tools/stock-planner?symbol=AAPL');
    expect(requestUpgrade).not.toHaveBeenCalled();
  });

  it('asks a locked reader to upgrade, and never asks the route for their plans', async () => {
    unlocked = false;
    await renderCard();
    expect(requests.some((url) => url.includes('/api/stock-plans'))).toBe(false);
    await act(async () => { cta()!.click(); });
    expect(requestUpgrade).toHaveBeenCalledWith({
      capability: 'planner.stock', source: 'stock-detail.plan-cta',
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('shows nothing at all for an instrument the planner refuses', async () => {
    await renderCard('index');
    expect(container.querySelector('[data-testid="stock-detail-plan-section"]')).toBeNull();
  });
});
