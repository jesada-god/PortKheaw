// @vitest-environment jsdom

/**
 * The Stock Planner's one piece of asynchronous behaviour: choosing a stock, and
 * the quote that follows it.
 *
 * The arithmetic is proved in `src/lib/tools/stock-plan.test.ts`. What cannot be
 * proved there is that the chosen stock actually reaches the screen with its
 * price on it, and that a plan typed on top of that quote reads back exactly
 * what the pure module computed — the wiring between the two is where a tool
 * like this fails silently, showing a loading skeleton forever while every unit
 * test stays green.
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

const SEARCH_RESULT = {
  symbol: 'AAPL', name: 'Apple Inc. - Common Stock', assetType: 'Stock', exchange: 'NASDAQ',
  status: 'active', currency: 'USD', marketOpen: null, marketClose: null, timezone: null,
  matchScore: 1, logoUrl: null,
};
const QUOTE = {
  data: { symbol: 'AAPL', currency: 'USD', price: 304.91, open: null, high: null, low: null,
    previousClose: 308.26, change: -3.35, changePercent: -1.0867, volume: null, latestTradingDay: '2026-08-11' },
  meta: { provider: 'polygon', timestamp: '2026-08-12T07:03:05.845Z', freshness: { status: 'delayed', asOf: null, maxAgeSeconds: null } },
};

let container: HTMLDivElement;
let root: Root;

/** Search then quote, in the order the workspace asks for them. */
function stubMarketData() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/market/search')) {
      return Promise.resolve(new Response(JSON.stringify({ data: [SEARCH_RESULT], meta: QUOTE.meta }), { status: 200 }));
    }
    if (url.includes('/api/market/quote/')) {
      return Promise.resolve(new Response(JSON.stringify(QUOTE), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }));
}

async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Search, wait out the debounce, and click the row for AAPL. */
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

function text(selector: string): string {
  return (container.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  it('shows the chosen stock with the price the quote route returned', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    const asset = text('[data-testid="stock-planner-asset"]');
    expect(asset).toContain('AAPL');
    expect(asset).toContain('Apple Inc. - Common Stock');
    expect(asset).toContain('NASDAQ');
    // The price, not a loading skeleton that never resolves.
    expect(asset).toContain('$304.91');
    expect(asset).toContain('-1.09%');
    // …and it seeds the entry, so a reader can plan from where the stock is.
    expect(field('stock-planner-entry').value).toBe('304.91');
  });

  it('reads back exactly what the plan implies, including the money at each exit', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    await act(async () => {
      type(field('stock-planner-entry'), '100');
      type(field('stock-planner-stop'), '95.8');
      type(field('stock-planner-target'), '110.1');
      type(field('stock-planner-size'), '5000');
    });
    await settle();

    const result = text('[data-testid="stock-planner-result"]');
    expect(result).toContain('-4.2%');
    expect(result).toContain('+10.1%');
    expect(result).toContain('1 : 2.4');
    expect(text('[data-testid="stock-planner-summary"]'))
      .toContain('แผนนี้ยอมเสี่ยง 1 ส่วน เพื่อหวังผลตอบแทนประมาณ 2.4 ส่วน');

    const position = text('[data-testid="stock-planner-position"]');
    expect(position).toContain('50 หุ้น');
    expect(position).toContain('$5,000.00');
    expect(position).toContain('-$210.00');
    expect(position).toContain('$505.00');
  });

  /*
    Opened from a holding, the plan starts where the reader's own row left off:
    the stock is chosen, the entry is the price that row showed, and the size is
    the position they actually hold. What they still choose for themselves are
    the three prices — this tool has never predicted one and does not start now.
  */
  it('opens straight onto a holding handed over from the portfolio', async () => {
    window.history.replaceState({}, '', '/tools/stock-planner?from=portfolio&type=etf&symbol=AAPL'
      + '&quantity=25&averageCost=180.25&price=210&marketValue=5250&unrealizedGain=743.75');
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    await settle();

    // No search, no second stock to pick: the asset arrived with the link.
    expect(text('[data-testid="stock-planner-asset"]')).toContain('AAPL');
    expect(text('[data-testid="stock-planner-asset"]')).toContain('ETF');
    expect(field('stock-planner-entry').value).toBe('210');
    expect(field('stock-planner-size').value).toBe('25');

    const context = text('[data-testid="stock-planner-holding"]');
    expect(context).toContain('25');
    expect(context).toContain('$180.25');
    expect(context).toContain('$5,250.00');
    expect(context).toContain('$743.75');

    // The prices are still empty — nothing was decided for the reader.
    expect(field('stock-planner-stop').value).toBe('');
    expect(field('stock-planner-target').value).toBe('');
  });

  it('ignores an option handed to it, rather than planning a strike as a share price', async () => {
    window.history.replaceState({}, '', '/tools/stock-planner?from=portfolio&type=option&symbol=ASTS'
      + '&optionKind=put&side=long&strike=73&expiration=2026-08-28&contracts=1&multiplier=100&premium=4.25');
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    await settle();

    expect(container.querySelector('[data-testid="stock-planner-asset"]')).toBeNull();
    expect(container.querySelector('[data-testid="stock-planner-holding"]')).toBeNull();
    expect(container.textContent).toContain('ยังไม่ได้เลือกหุ้น');
    expect(container.textContent).not.toContain('73');
  });

  it('refuses an impossible plan in place, and never prints a directive', async () => {
    await act(async () => { root.render(<StockPlannerWorkspace />); });
    await chooseAapl();

    await act(async () => {
      type(field('stock-planner-entry'), '100');
      type(field('stock-planner-stop'), '120');
      type(field('stock-planner-target'), '110');
    });
    await settle();

    expect(text('#stock-planner-stop-error')).toBe('จุดตัดขาดทุนต้องต่ำกว่าราคาที่สนใจเข้า');
    expect(container.querySelector('[data-testid="stock-planner-result"]')).toBeNull();
    expect(container.textContent).not.toMatch(/ควรซื้อ|ซื้อเลย|ควรขาย|ขายเลย/);
    // The standing disclaimer is on the page whether or not a plan is valid.
    expect(text('[data-testid="stock-planner-disclaimer"]')).toContain('ไม่ใช่คำแนะนำการลงทุน');
  });
});
