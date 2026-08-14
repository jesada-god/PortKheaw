// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Which tool a position can reach, from the position itself.
 *
 * The routing rule is proved in `src/lib/tools/handoff.test.ts`; what is proved
 * here is that the buttons on the cards obey it — a contract can only reach the
 * two option simulators, shares and ETFs can only reach the planner, and the
 * position travels with them so nothing is retyped. The last two tests are the
 * ones that matter most: a locked reader meets the upgrade prompt instead of the
 * tool, and no URL this component builds carries anything that could unlock one.
 */

const push = vi.fn();
const requestUpgrade = vi.fn();
let entitled = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  useEntitlement: () => ({ can: () => entitled, requestUpgrade }),
}));

vi.mock('@/src/components/instruments/InstrumentLogo', () => ({
  InstrumentLogo: () => null,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));

import { PositionToolAction } from './PositionToolAction';
import { HoldingCard } from './tracker/HoldingCard';
import type { HoldingSummary } from '@/src/lib/portfolio/types';
import type { PortfolioToolContext } from '@/src/lib/tools/handoff';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PORTFOLIO_ID = '11111111-1111-4111-8111-111111111111';

const OPTION_CONTEXT: PortfolioToolContext = {
  type: 'option',
  symbol: 'ASTS',
  optionKind: 'put',
  side: 'long',
  strike: 73,
  expiration: '2026-08-28',
  contracts: 1,
  multiplier: 100,
  premium: 4.25,
  mark: 5.1,
  underlyingPrice: 60.5,
  impliedVolatility: 0.82,
  contractSymbol: 'ASTS260828P00073000',
  portfolioId: PORTFOLIO_ID,
};

function holding(symbol: string): HoldingSummary {
  return {
    symbol,
    quantity: 25,
    averageCost: 180.25,
    costBasis: 4_506.25,
    marketPrice: 210,
    marketValue: 5_250,
    realizedGain: 0,
    unrealizedGain: 743.75,
    allocation: 100,
    priceCached: false,
    priceStale: false,
    priceSource: 'canonical-market-snapshot',
    priceAsOf: '2026-08-14T12:00:00.000Z',
    todayChange: 12,
    todayChangePercent: 0.5,
    lots: [],
    transactions: [],
  };
}

let container: HTMLDivElement;
let root: Root;

function click(element: Element | null | undefined) {
  if (!element) throw new Error('Nothing to click');
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const one = (selector: string) => document.body.querySelector(selector);
const all = (selector: string) => [...document.body.querySelectorAll(selector)];

async function renderHolding(assetType: 'stock' | 'etf', symbol: string) {
  await act(async () => {
    root.render(<HoldingCard
      holding={holding(symbol)}
      expanded
      showBalances
      timezone="Asia/Bangkok"
      portfolioId={PORTFOLIO_ID}
      assetType={assetType}
      canWrite
      money={(value) => String(value ?? '—')}
      signed={(value) => String(value ?? '—')}
      hidden={(value) => value}
      onToggle={() => undefined}
      onBuy={() => undefined}
      onSell={() => undefined}
      onCloseAll={() => undefined}
    />);
  });
}

async function renderOptionTool() {
  await act(async () => {
    root.render(<PositionToolAction
      context={OPTION_CONTEXT}
      label="จำลองสถานการณ์"
      source="portfolio.option-position"
    />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  entitled = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('an option position', () => {
  it('offers the two option simulators and never the Stock Planner', async () => {
    await renderOptionTool();
    click(one('[data-testid="position-tool-option"]'));
    const ids = all('[data-testid^="position-tool-option-"]').map((node) => node.getAttribute('data-testid'));
    expect(ids).toEqual(['position-tool-option-what-if', 'position-tool-option-monte-carlo']);
    expect(one('[data-testid="position-tool-option-stock-planner"]')).toBeNull();
  });

  it('carries the whole contract into the simulator so nothing is retyped', async () => {
    await renderOptionTool();
    click(one('[data-testid="position-tool-option"]'));
    click(one('[data-testid="position-tool-option-what-if"]'));
    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0] as string, 'https://portkheaw.vercel.app');
    expect(url.pathname).toBe('/tools/what-if');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      from: 'portfolio',
      type: 'option',
      symbol: 'ASTS',
      optionKind: 'put',
      side: 'long',
      strike: '73',
      expiration: '2026-08-28',
      contracts: '1',
      multiplier: '100',
      premium: '4.25',
      impliedVolatility: '0.82',
    });
  });

  it('reaches Monte Carlo on its own route', async () => {
    await renderOptionTool();
    click(one('[data-testid="position-tool-option"]'));
    click(one('[data-testid="position-tool-option-monte-carlo"]'));
    expect(String(push.mock.calls[0][0])).toContain('/tools/monte-carlo?');
  });
});

describe('a share and an ETF holding', () => {
  it('opens the Stock Planner directly, because there is nothing to choose between', async () => {
    await renderHolding('stock', 'AAPL');
    const button = one('[data-testid="position-tool-stock"]');
    expect(button?.textContent).toContain('วางแผน');
    expect(button?.getAttribute('data-tool-count')).toBe('1');
    click(button);
    // No chooser: one tool means one tap.
    expect(one('[data-testid="position-tool-chooser"]')).toBeNull();
    const url = new URL(push.mock.calls[0][0] as string, 'https://portkheaw.vercel.app');
    expect(url.pathname).toBe('/tools/stock-planner');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      from: 'portfolio',
      type: 'stock',
      symbol: 'AAPL',
      quantity: '25',
      averageCost: '180.25',
      price: '210',
    });
  });

  /*
   * SPY is four plausible letters, exactly like AAPL. Only the instrument
   * master knows one of them is an ETF, and the card is told rather than
   * guessing — but both land in the same planner, which is what the planner is
   * for.
   */
  it('routes an ETF to the same planner, labelled as an ETF', async () => {
    await renderHolding('etf', 'SPY');
    click(one('[data-testid="position-tool-etf"]'));
    const url = new URL(push.mock.calls[0][0] as string, 'https://portkheaw.vercel.app');
    expect(url.pathname).toBe('/tools/stock-planner');
    expect(url.searchParams.get('type')).toBe('etf');
    expect(url.searchParams.get('symbol')).toBe('SPY');
  });

  it('never offers an option simulator to equity', async () => {
    for (const [type, symbol] of [['stock', 'AAPL'], ['etf', 'SPY']] as const) {
      await renderHolding(type, symbol);
      expect(document.body.textContent).not.toContain('What-If');
      expect(document.body.textContent).not.toContain('Monte Carlo');
      expect(one(`[data-testid="position-tool-${type}"]`)?.getAttribute('data-tool-count')).toBe('1');
    }
  });
});

describe('a reader whose plan does not carry the tool', () => {
  it('meets the upgrade prompt instead of the tool', async () => {
    entitled = false;
    await renderOptionTool();
    click(one('[data-testid="position-tool-option"]'));
    expect(one('[data-testid="position-tool-option-what-if"]')?.getAttribute('data-locked')).toBe('true');
    click(one('[data-testid="position-tool-option-what-if"]'));
    expect(push).not.toHaveBeenCalled();
    expect(requestUpgrade).toHaveBeenCalledWith({
      capability: 'simulator.what_if',
      source: 'portfolio.option-position.what-if',
    });
  });

  it('is refused the planner the same way', async () => {
    entitled = false;
    await renderHolding('etf', 'SPY');
    click(one('[data-testid="position-tool-etf"]'));
    expect(push).not.toHaveBeenCalled();
    expect(requestUpgrade).toHaveBeenCalledWith({
      capability: 'planner.stock',
      source: 'portfolio.holding.stock-planner',
    });
  });

  /*
   * The prompt is a courtesy. The refusal that counts is on the server — the
   * simulators' compute routes and the planner's own page — so the link this
   * component builds deliberately carries nothing an entitlement could be read
   * from, and there is nothing in it to tamper with.
   */
  it('builds a link that carries no entitlement to tamper with', async () => {
    await renderHolding('stock', 'AAPL');
    click(one('[data-testid="position-tool-stock"]'));
    const url = new URL(push.mock.calls[0][0] as string, 'https://portkheaw.vercel.app');
    for (const forbidden of ['tier', 'capability', 'plan', 'entitlement', 'unlock', 'access', 'preview']) {
      expect(url.searchParams.has(forbidden)).toBe(false);
    }
  });
});
