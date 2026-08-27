// @vitest-environment jsdom

/**
 * The Stock Planner's wiring: the stock a reader chooses, the canonical price
 * that follows it, and the plan they then state on top of it.
 *
 * The arithmetic is proved in `src/lib/tools/stock-plan-outlook.test.ts`. What
 * cannot be proved there is that the chosen stock reaches the screen with the
 * canonical accepted price on it, that the plan reads back exactly what the pure
 * module computed, and that the three refusals actually refuse — the wiring is
 * where a tool like this fails silently, showing a skeleton forever while every
 * unit test stays green.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/tools/stock-planner',
}));
vi.mock('@/src/components/layout/Header', () => ({
  default: ({ title }: { title: string }) => <header>{title}</header>,
}));

import { StockPlannerWorkspace } from './StockPlannerWorkspace';
import { evaluateStockPlan, formatRiskRewardRatio, stockPlanStatus, STOCK_PLAN_STATUS_LABEL } from '@/src/lib/tools/stock-plan';

const SEARCH_RESULT = {
  symbol: 'AAPL', name: 'Apple Inc. - Common Stock', assetType: 'Stock', exchange: 'NASDAQ',
  status: 'active', currency: 'USD', marketOpen: null, marketClose: null, timezone: null,
  matchScore: 1, logoUrl: null,
};

/** What `/api/tools/planner-price` returns — the canonical accepted price. */
const PLANNER_PRICE = {
  data: {
    symbol: 'AAPL', name: 'Apple Inc. - Common Stock', assetType: 'stock', exchange: 'NASDAQ',
    currency: 'USD', acceptedPrice: 100, session: 'REGULAR', asOf: '2026-08-14T18:00:00.000Z',
    unsupported: null,
  },
};

const CRYPTO_PRICE = {
  data: {
    symbol: 'BTC-USD', name: 'Bitcoin', assetType: 'crypto', exchange: null,
    currency: 'USD', acceptedPrice: null, session: 'UNKNOWN', asOf: null,
    unsupported: 'เครื่องมือวางแผนนี้ (v1) ยังไม่รองรับคริปโท เพราะเป็นตลาดที่ซื้อขายต่อเนื่องตลอด 24 ชั่วโมง จึงใช้ระยะเวลาแบบเดียวกับหุ้นไม่ได้',
  },
};

let container: HTMLDivElement;
let root: Root;
let savedPlans: unknown[] = [];
let posted: { url: string; body: unknown }[] = [];

function stubMarketData(priceResponse: unknown = PLANNER_PRICE) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/market/search')) {
      return Promise.resolve(new Response(JSON.stringify({ data: [SEARCH_RESULT] }), { status: 200 }));
    }
    if (url.includes('/api/tools/planner-price/')) {
      return Promise.resolve(new Response(JSON.stringify(priceResponse), { status: 200 }));
    }
    if (url.includes('/api/stock-plans')) {
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ data: savedPlans }), { status: 200 }));
      }
      posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 201 }));
    }
    if (url.includes('/api/market/chart-levels')) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { pivot: 100, resistance: [104, 108, 112], support: [96, 92, 88] },
      }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }));
}

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function chooseAapl() {
  const search = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => { search.focus(); type(search, 'AAPL'); });
  await act(async () => { vi.advanceTimersByTime(400); });
  await settle();
  const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(option, 'search offered no result to choose').not.toBeNull();
  await act(async () => { option.click(); });
  await settle();
}

function field(testId: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
}

function click(testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  expect(button, `no ${testId} to click`).not.toBeNull();
  return act(async () => { button.click(); });
}

function text(selector: string): string {
  return (container.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** A plan whose numbers are round enough to check by eye: +10% / -4% / 1 : 2.5. */
async function statePlan() {
  await act(async () => {
    type(field('stock-planner-target'), '110');
    type(field('stock-planner-invalidation'), '96');
  });
  await settle();
  await click('stock-planner-analyze');
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T18:00:00.000Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  savedPlans = [];
  posted = [];
  stubMarketData();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Stock Planner workspace', () => {
  it('shows the chosen stock with the canonical accepted price, read-only', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    expect(text('[data-testid="stock-planner-asset"]')).toContain('AAPL');
    expect(text('[data-testid="stock-planner-current-price"]')).toContain('$100.00');

    // The baseline is on the page, and the reader cannot type over it.
    const baseline = field('stock-planner-baseline');
    expect(baseline.value).toBe('$100.00');
    expect(baseline.readOnly).toBe(true);
  });

  it('reads back exactly what the plan implies, and calls the distance a distance', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    expect(text('[data-testid="stock-planner-upside"]')).toBe('+10.0%');
    expect(text('[data-testid="stock-planner-downside"]')).toBe('-4.0%');
    expect(text('[data-testid="stock-planner-reward-risk"]')).toBe('1 : 2.5');

    // The sentence that keeps the number honest is on screen with it.
    expect(text('[data-testid="stock-planner-not-probability"]'))
      .toContain('โอกาสขึ้นคือส่วนต่างถึงราคาเป้าหมาย ไม่ใช่ความน่าจะเป็น');

    // Three scenarios, all of them the reader's own levels, labelled as such.
    expect(text('[data-testid="stock-planner-scenario-invalidation"]')).toContain('$96.00');
    expect(text('[data-testid="stock-planner-scenario-flat"]')).toContain('$100.00');
    expect(text('[data-testid="stock-planner-scenario-target"]')).toContain('$110.00');
    expect(text('[data-testid="stock-planner-scenarios"]')).not.toContain('คาดการณ์');

    // Nothing anywhere tells the reader what to do.
    expect(container.textContent).not.toMatch(/ควรซื้อ|ซื้อเลย|ควรขาย|ขายเลย|แนะนำให้/);
  });

  it('keeps the details collapsed until asked, then reuses the existing S&R service', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    expect(container.querySelector('[data-testid="stock-planner-details"]')).toBeNull();

    await click('stock-planner-details-toggle');
    await settle();

    expect(container.querySelector('[data-testid="stock-planner-details"]')).not.toBeNull();
    // Support/resistance from the app's own chart-levels service, not a new one.
    expect(text('[data-testid="stock-planner-sr"]')).toContain('$96.00');
    expect(text('[data-testid="stock-planner-sr"]')).toContain('$104.00');
    // The sizing planner this tool shipped with is still here, in full.
    expect(container.querySelector('[data-testid="stock-planner-entry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stock-planner-size"]')).not.toBeNull();
  });

  /*
    ผลตอบแทนจำลอง. The amount is optional, so the first thing that must be true
    is that a reader who ignores it gets exactly the tool they had before.
  */
  it('plans without an amount, and only offers the simulation', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    // The plan itself is unaffected by an empty optional box.
    expect(text('[data-testid="stock-planner-upside"]')).toBe('+10.0%');
    expect(field('stock-planner-investment').value).toBe('');
    expect(container.querySelector('[data-testid="stock-planner-simulation"]')).toBeNull();
    expect(text('[data-testid="stock-planner-simulation-hint"]')).toContain('กรอกจำนวนเงินที่ต้องการลงทุน');
  });

  /*
    The money, measured from the reader's own ราคาเข้า. The entry here is 105
    against a current price of 100 on purpose: every figure below is wrong by a
    visible amount if the simulation ever measures from the baseline instead.

    $1,000 ÷ $105 = 9 whole shares, $945 committed.
      profit = 9 × (110 − 105) = +$45.00, and 5/105 = +4.8%
      loss   = 9 × (96 − 105)  = −$81.00, and 9/105 = −8.6%
      R : R  = 5 ÷ 9 = 1 : 0.6
  */
  it('turns an amount into shares, profit and loss priced from the entry', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    await act(async () => {
      type(field('stock-planner-entry'), '105');
      type(field('stock-planner-investment'), '1000');
    });
    await settle();

    expect(text('[data-testid="stock-planner-sim-investment"]')).toBe('$1,000.00');
    expect(text('[data-testid="stock-planner-sim-entry"]')).toBe('$105.00');
    expect(text('[data-testid="stock-planner-sim-shares"]')).toBe('9 หุ้น');
    expect(text('[data-testid="stock-planner-sim-cost"]')).toBe('$945.00');
    expect(text('[data-testid="stock-planner-sim-target"]')).toBe('$110.00');
    expect(text('[data-testid="stock-planner-sim-invalidation"]')).toBe('$96.00');

    // Profit positive, loss negative, each with its percentage of the money committed.
    expect(text('[data-testid="stock-planner-sim-profit"]')).toBe('+$45.00 +4.8%');
    expect(text('[data-testid="stock-planner-sim-loss"]')).toBe('-$81.00 -8.6%');
    // The ratio the shipped planner already computes — entry-based, like the money.
    expect(text('[data-testid="stock-planner-sim-reward-risk"]')).toBe('1 : 0.6');

    // A simulation, and it says so.
    expect(text('[data-testid="stock-planner-sim-note"]')).toContain('ไม่ใช่การรับประกันผลตอบแทน');
    // Typing an amount is not a change to the plan, so the analysis stays on screen.
    expect(container.querySelector('[data-testid="stock-planner-result"]')).not.toBeNull();
  });

  /* With the entry left as the price the tool filled in: $1,000 buys 10 at $100. */
  it('prices the simulation from the entry the tool prefilled', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    await act(async () => { type(field('stock-planner-investment'), '1000'); });
    await settle();

    expect(field('stock-planner-entry').value).toBe('100');
    expect(text('[data-testid="stock-planner-sim-shares"]')).toBe('10 หุ้น');
    expect(text('[data-testid="stock-planner-sim-profit"]')).toBe('+$100.00 +10.0%');
    expect(text('[data-testid="stock-planner-sim-loss"]')).toBe('-$40.00 -4.0%');
  });

  /*
    An amount the plan cannot be built from is answered with a placeholder and a
    reason, never with a number that had to be invented to fill the row.
  */
  it('refuses to force a figure when the plan cannot carry the amount', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    await act(async () => { type(field('stock-planner-investment'), '40'); });
    await settle();

    expect(text('[data-testid="stock-planner-sim-shares"]')).toBe('—');
    expect(text('[data-testid="stock-planner-sim-profit"]')).toBe('—');
    expect(text('[data-testid="stock-planner-sim-loss"]')).toBe('—');
    expect(text('[data-testid="stock-planner-sim-blocked"]')).toContain('ยังซื้อได้ไม่ถึง 1 หุ้น');

    // And with no entry price there is nothing to divide by, so nothing is shown.
    await act(async () => {
      type(field('stock-planner-entry'), '');
      type(field('stock-planner-investment'), '1000');
    });
    await settle();
    expect(text('[data-testid="stock-planner-sim-shares"]')).toBe('—');
    expect(text('[data-testid="stock-planner-sim-cost"]')).toBe('—');
    expect(text('[data-testid="stock-planner-sim-reward-risk"]')).toBe('—');
  });

  /*
    The line this feature must not cross. The amount is a simulation input: it
    reaches no portfolio, no ledger and no saved plan.
  */
  it('never sends the simulated amount anywhere', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();

    await act(async () => { type(field('stock-planner-investment'), '1000'); });
    await settle();
    await click('stock-planner-save');
    await settle();

    const create = posted.find((entry) => entry.url.endsWith('/api/stock-plans'));
    expect(create!.body).toEqual({
      symbol: 'AAPL', baselinePrice: 100, targetPrice: 110, invalidationPrice: 96,
      horizonDate: '2026-11-14',
    });
    // Nothing was written anywhere else — no transaction, no position, no holding.
    const writes = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') !== 'GET');
    expect(writes.every(([url]) => String(url).includes('/api/stock-plans'))).toBe(true);
  });

  it('saves a plan carrying the baseline exactly once, on create', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();
    await statePlan();
    await click('stock-planner-save');
    await settle();

    const create = posted.find((entry) => entry.url.endsWith('/api/stock-plans'));
    expect(create, 'no plan was posted').toBeDefined();
    expect(create!.body).toMatchObject({
      symbol: 'AAPL', baselinePrice: 100, targetPrice: 110, invalidationPrice: 96,
    });
    // The default horizon is three months out, as the spec requires.
    expect((create!.body as { horizonDate: string }).horizonDate).toBe('2026-11-14');
  });

  it('refuses an inverted plan in place, and shows no result for it', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    await act(async () => {
      type(field('stock-planner-target'), '90');
      type(field('stock-planner-invalidation'), '120');
    });
    await settle();
    await click('stock-planner-analyze');
    await settle();

    expect(text('#stock-planner-target-error')).toBe('ราคาเป้าหมายต้องสูงกว่าราคาปัจจุบัน');
    expect(text('#stock-planner-invalidation-error')).toBe('ระดับที่แผนไม่เป็นไปตามคาดต้องต่ำกว่าราคาปัจจุบัน');
    expect(container.querySelector('[data-testid="stock-planner-result"]')).toBeNull();
    expect(text('[data-testid="stock-planner-disclaimer"]')).toContain('ไม่ใช่คำแนะนำการลงทุน');
  });

  /*
    The fail-safe. A crypto pair reaches the planner the same way any symbol
    does; what must not happen is that it is planned anyway, or that a baseline
    appears for something the tool will not plan.
  */
  it('refuses an asset outside v1 scope, with a reason and no plan form', async () => {
    stubMarketData(CRYPTO_PRICE);
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    expect(text('[data-testid="stock-planner-unsupported"]')).toContain('ยังไม่รองรับคริปโท');
    expect(container.querySelector('[data-testid="stock-planner-baseline"]')).toBeNull();
    expect(container.querySelector('[data-testid="stock-planner-analyze"]')).toBeNull();
  });

  it('ignores an option handed to it, rather than planning a strike as a share price', async () => {
    window.history.replaceState({}, '', '/tools/stock-planner?from=portfolio&type=option&symbol=ASTS'
      + '&optionKind=put&side=long&strike=73&expiration=2026-08-28&contracts=1&multiplier=100&premium=4.25');
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    await settle();

    expect(container.querySelector('[data-testid="stock-planner-asset"]')).toBeNull();
    expect(container.textContent).toContain('ยังไม่ได้เลือกหุ้น');
    expect(container.textContent).not.toContain('73');
  });

  /* The Stock Detail CTA arrives with a symbol and nothing else. */
  it('opens straight onto the symbol the Stock Detail CTA handed over', async () => {
    window.history.replaceState({}, '', '/tools/stock-planner?symbol=AAPL');
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    await settle();

    expect(text('[data-testid="stock-planner-asset"]')).toContain('AAPL');
    expect(field('stock-planner-baseline').value).toBe('$100.00');
    // Nothing about the plan itself was decided for the reader.
    expect(field('stock-planner-target').value).toBe('');
    expect(field('stock-planner-invalidation').value).toBe('');
  });

  /*
    Editing a saved plan measures against the baseline the plan was MADE at, not
    against today's price. If this ever regresses, every percentage on an edited
    plan silently becomes a statement about a different day.
  */
  it('edits against the stored baseline and never sends a new one', async () => {
    savedPlans = [{
      id: '11111111-1111-4111-8111-111111111111', symbol: 'AAPL', baselinePrice: 200,
      targetPrice: 240, invalidationPrice: 180, horizonDate: '2026-12-31',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }];
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await settle();

    await click('saved-plan-edit-AAPL');
    await settle();

    // The stored baseline, not the 100 the price route is returning today.
    expect(field('stock-planner-baseline').value).toBe('$200.00');

    await act(async () => { type(field('stock-planner-target'), '260'); });
    await settle();
    await click('stock-planner-analyze');
    await settle();
    await click('stock-planner-save');
    await settle();

    const update = posted.find((entry) => entry.url.includes('/api/stock-plans/'));
    expect(update, 'no edit was sent').toBeDefined();
    expect(update!.body).toMatchObject({ targetPrice: 260, invalidationPrice: 180 });
    expect(update!.body).not.toHaveProperty('baselinePrice');
  });
});

/*
 * The plan's status is a restatement of the ratio beside it, in words. What
 * these hold is the line it must not cross: it describes the proportion between
 * three prices the reader chose, and never whether the plan is a good one.
 */
describe('the plan status line', () => {
  it('says nothing about the plan until all three prices are stated', () => {
    expect(stockPlanStatus(null)).toBe('unknown');
    expect(STOCK_PLAN_STATUS_LABEL.unknown).toBe('ยังกรอกไม่ครบ');
  });

  it('reads the same ratio the Risk / Reward figure prints', () => {
    const levels = evaluateStockPlan({
      entry: 100, stopLoss: 90, target: 130, sizing: { mode: 'budget', amount: null },
    }).levels!;
    expect(formatRiskRewardRatio(levels.rewardToRisk)).toBe('1 : 3.0');
    expect(stockPlanStatus(levels)).toBe('good');
  });
});
