// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const loadExpirations = vi.fn();
const loadChain = vi.fn();
vi.mock('@/src/lib/stock-detail/options-source', () => ({
  DEFAULT_EXPIRATIONS_COOLDOWN_MS: 60_000,
  OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS: 60_000,
  optionsExpirationsCoordinator: { load: (symbol: string) => loadExpirations(symbol) },
  optionsChainCoordinator: {
    load: (symbol: string, expiration: string, price: number | null) => loadChain(symbol, expiration, price),
    reset: () => true,
  },
}));

import { OptionsChainPanel } from './OptionsChainPanel';

vi.stubGlobal('React', React);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AS_OF = '2026-07-27T13:30:00.000Z';
const EXPIRATION = '2026-08-21';
const SPOT = 208.5;
/** A real OCC-format symbol: 20 characters, the longest thing a row must hold. */
const LONG_SYMBOL = 'RKLB260821C00012500X';

function contract(overrides: Partial<OptionContract> & Pick<OptionContract, 'type' | 'strike'>): OptionContract {
  return {
    contractSymbol: `AAPL260821${overrides.type === 'call' ? 'C' : 'P'}00${overrides.strike}000`,
    underlyingSymbol: 'AAPL', expiration: EXPIRATION,
    bid: null, ask: null, last: null, mark: null,
    volume: null, openInterest: null, impliedVolatility: null,
    delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD',
    provider: 'alpaca', marketDataProvider: null, marketDataFeed: null,
    asOf: AS_OF, oiAsOf: null, timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: null, valuationSource: null,
    ...overrides,
  };
}

const chain: OptionsChain = {
  underlyingSymbol: 'AAPL', spot: SPOT, expiration: EXPIRATION, expirations: [EXPIRATION],
  calls: [
    contract({ type: 'call', strike: 200, bid: 9.4, ask: 9.8, last: 9.6, volume: 0, openInterest: 1250, impliedVolatility: 0.3125, delta: 0.71, gamma: 0.02, theta: -0.08, contractSymbol: LONG_SYMBOL }),
    contract({ type: 'call', strike: 210 }),
  ],
  puts: [
    contract({ type: 'put', strike: 200, bid: 1.1, ask: 1.3, openInterest: 640 }),
  ],
  provider: 'alpaca', asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
  delayedMinutes: 15, completeness: 0.92, warnings: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('React', React);
  // The panel only requests data while the tab is active; jsdom reports the
  // document as unfocused, which would keep it in its idle state forever.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  push.mockReset();
  loadExpirations.mockReset().mockResolvedValue({ ok: true, data: { underlyingSymbol: 'AAPL', expirations: [EXPIRATION], provider: 'alpaca', asOf: AS_OF, timestampKind: 'receipt', status: 'delayed', delayedMinutes: 15, warnings: [] }, expirations: [EXPIRATION] });
  loadChain.mockReset().mockResolvedValue({ ok: true, chain });
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const UNDERLYING: MarketDataLabel = {
  mode: 'DELAYED', provider: 'alpaca', source: 'snapshot', exchangeTimestamp: AS_OF,
  receivedAt: AS_OF, delayAgeSeconds: 900, fallbackNote: null,
};

async function renderChain() {
  await act(async () => {
    root.render(<OptionsChainPanel symbol="AAPL" acceptedPrice={SPOT} underlyingLabel={UNDERLYING} />);
  });
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="วันหมดอายุออปชัน"]')!;
  await act(async () => {
    select.value = EXPIRATION;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="options-strike-row"]')];
}
function click(element: Element) {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('OptionsChainPanel layout', () => {
  it('renders one auto-height row per strike, never a fixed row height', async () => {
    await renderChain();
    const rendered = rows();
    expect(rendered).toHaveLength(2);
    // A pinned row height is exactly what made the old table overlap itself: the
    // row element must carry no inline height and no clipping of its own content.
    for (const row of rendered) {
      expect(row.style.height).toBe('');
      expect(row.style.maxHeight).toBe('');
    }
  });

  it('stacks each contract as status → prices → activity → Greeks → actions, with nothing overlaid', async () => {
    await renderChain();
    const call = rows()[0].querySelector<HTMLElement>('[data-testid="option-cell-call"]')!;
    const sections = [...call.children].map((child) => child.getAttribute('aria-label') ?? child.tagName);
    expect(sections).toEqual(['DIV', 'ราคา CALL', 'สภาพคล่อง CALL', 'Greeks CALL', 'DIV']);
    // Nothing in a cell is taken out of flow, so no element can land on another.
    for (const node of call.querySelectorAll<HTMLElement>('*')) {
      expect(node.className).not.toMatch(/\babsolute\b|\bfixed\b/);
    }
  });

  it('keeps the full contract symbol in the DOM and truncates it with CSS plus a tooltip', async () => {
    await renderChain();
    const symbol = rows()[0].querySelector<HTMLElement>('[data-testid="option-contract-symbol"]')!;
    expect(symbol.textContent).toBe(LONG_SYMBOL);
    expect(symbol.title).toBe(LONG_SYMBOL);
    expect(symbol.className).toContain('truncate');
    expect(symbol.className).toContain('min-w-0');
  });

  it('shows a dash for every field the provider did not supply, and keeps a real zero', async () => {
    await renderChain();
    const call = rows()[0].querySelector<HTMLElement>('[data-testid="option-cell-call"]')!;
    const values = [...call.querySelectorAll('dd')].map((node) => node.textContent);
    expect(values).toEqual(['9.4', '9.8', '9.6', '9.6', '0', '1,250', '31.25%', '8.5', '0.71', '0.02', '-0.08']);

    const put = rows()[0].querySelector<HTMLElement>('[data-testid="option-cell-put"]')!;
    const putValues = [...put.querySelectorAll('dd')].map((node) => node.textContent);
    // No last trade, no IV, no Greeks from the provider — all dashes, never zeros.
    expect(putValues).toEqual(['1.1', '1.3', '1.2', '—', '—', '640', '—', '0', '—', '—', '—']);
  });

  it('renders a missing side as a dash instead of inventing a contract', async () => {
    await renderChain();
    const empty = rows()[1].querySelector<HTMLElement>('[data-testid="option-cell-put-empty"]')!;
    expect(empty.textContent).toContain('—');
    expect(rows()[1].querySelector('[data-testid="option-cell-put"]')).toBeNull();
  });

  it('states once, not per row, that the provider supplied no IV or Greeks', async () => {
    loadChain.mockResolvedValue({
      ok: true,
      chain: { ...chain, calls: chain.calls.map((item) => ({ ...item, delta: null, gamma: null, theta: null, impliedVolatility: null })) },
    });
    await renderChain();
    expect(container.querySelector('[data-testid="options-greeks-missing"]')?.textContent).toContain('—');
  });

  it('gives both row actions a ≥44px touch target that relaxes on pointer viewports', async () => {
    await renderChain();
    const buttons = [...rows()[0].querySelectorAll<HTMLButtonElement>('[data-testid="option-cell-call"] button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Strike line', 'Simulator']);
    for (const button of buttons) {
      expect(button.className).toContain('min-h-11');
      expect(button.className).toContain('md:min-h-9');
    }
  });

  it('keeps Strike line writing a real chart line for the selected contract', async () => {
    await renderChain();
    click(rows()[0].querySelector('[data-testid="option-cell-call"] button')!);
    const stored = JSON.parse(window.localStorage.getItem('nexora:strike-lines:AAPL:v1') ?? '[]');
    expect(stored).toEqual([expect.objectContaining({ id: `option:${LONG_SYMBOL}`, price: 200, optionType: 'call', expiration: EXPIRATION, visible: true })]);
  });

  it('keeps Simulator navigating with the contract and underlying provenance', async () => {
    await renderChain();
    const buttons = [...rows()[0].querySelectorAll<HTMLButtonElement>('[data-testid="option-cell-call"] button')];
    click(buttons[1]);
    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], 'https://example.test');
    expect(url.pathname).toBe('/tools/monte-carlo');
    expect(url.searchParams.get('contract')).toBe(LONG_SYMBOL);
    expect(url.searchParams.get('symbol')).toBe('AAPL');
    expect(url.searchParams.get('underlyingPrice')).toBe(String(SPOT));
    expect(url.searchParams.get('underlyingMode')).toBe('DELAYED');
  });

  it('confines scrolling to the options container so the page never scrolls sideways', async () => {
    await renderChain();
    const scroller = container.querySelector<HTMLElement>('[data-testid="options-chain-scroller"]')!;
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('overscroll-contain');
    // The desktop ledger width is breakpoint-gated: below md the card layout has
    // no minimum width, so a 320px viewport cannot overflow horizontally.
    const widthCarrier = container.querySelector('[class*="min-w-[40rem]"]')!;
    expect(widthCarrier.className).toContain('md:min-w-[40rem]');
    expect(widthCarrier.className).not.toMatch(/(^|\s)min-w-\[40rem\]/);
  });

  it('marks strikes outside the Expected Move band without hiding them', async () => {
    // 245 sits inside the ±20% strike range but outside the IV-derived band.
    loadChain.mockResolvedValue({
      ok: true,
      chain: { ...chain, calls: [...chain.calls, contract({ type: 'call', strike: 245, openInterest: 12 })] },
    });
    await renderChain();
    expect(rows()).toHaveLength(3);
    const flagged = rows().filter((row) => row.textContent?.includes('นอกกรอบ'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].getAttribute('aria-label')).toBe('Strike 245');
  });
});
