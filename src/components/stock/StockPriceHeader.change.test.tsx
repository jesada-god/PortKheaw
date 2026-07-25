// @vitest-environment jsdom

/**
 * Behavioural guard for the daily-change display in {@link StockPriceHeader}.
 *
 * The header must render `change` + `changePercent` next to the price whenever a
 * truthful change exists — either the provider's own change (even when it omitted
 * a previous close) or one derived from a real previous close — and hide it only
 * when neither exists. Colour/arrow follow the sign; a USD/THB toggle converts the
 * change amount but never the percentage.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import { StockPriceHeader, type TransientPriceSink } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

const FRESHNESS: DataFreshness = { status: 'delayed', asOf: '2026-07-23T14:30:00.000Z', maxAgeSeconds: 900 };

const BASE_QUOTE: Quote = {
  symbol: 'RKLB',
  currency: 'USD',
  price: 69.75,
  open: 71,
  high: 72,
  low: 69,
  previousClose: 72.45,
  change: -2.7,
  changePercent: -3.73,
  volume: 1_000_000,
  latestTradingDay: null,
};

function baseProps(quote: Quote | null, extra: Record<string, unknown> = {}) {
  return {
    symbol: 'RKLB',
    exchange: 'NASDAQ',
    sourceCurrency: 'USD',
    quote,
    freshness: FRESHNESS,
    market: { currentStatus: 'open' as const, notes: null },
    provider: 'polygon',
    providerConfigured: true,
    quoteError: null,
    fallbackLabel: null,
    quoteLoading: false,
    quoteRetryAt: 0,
    onRetryQuote: () => {},
    fxQuote: null as FxQuote | null,
    evaluatedAt: '2026-07-23T14:31:00.000Z',
    connectionState: null,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Record<string, unknown>) {
  act(() => { root.render(React.createElement(StockPriceHeader, props as never)); });
}

/** The div that wraps the change amount + percent. It is the only element styled
 *  `text-base font-semibold`, so neither the currency span nor the muted metadata
 *  row (both text-text-muted / text-sm) can be mistaken for it. */
function changeRow(): HTMLElement | null {
  return container.querySelector('div.text-base.font-semibold');
}

describe('StockPriceHeader daily change display', () => {
  it('updates a trade tick through the ref sink without a React state update', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));

    expect(transientPriceSinkRef.current).not.toBeNull();
    transientPriceSinkRef.current?.(70.1234);

    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('70.1234');
  });

  it('does not let an unrelated React render overwrite the latest transient price', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));
    transientPriceSinkRef.current?.(206.87, {
      asOf: '2026-07-24T20:26:14.801Z',
      feed: 'iex',
    });

    render(baseProps({ ...BASE_QUOTE, price: 212.06 }, {
      transientPriceSinkRef,
      connectionState: 'connected',
    }));

    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
  });

  it('renders change + percent from a REST quote with price and previous close', () => {
    // Provider omitted its own change: derive from the real previous close.
    render(baseProps({ ...BASE_QUOTE, change: null, changePercent: null }));
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).toContain('-2.70');
    expect(container.textContent).toContain('(-3.73%)');
  });

  it('renders the provider change even when the previous close is missing', () => {
    // The production defect: previousClose null but todaysChange/Perc present.
    render(baseProps({ ...BASE_QUOTE, previousClose: null }));
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).toContain('-2.70');
    expect(container.textContent).toContain('(-3.73%)');
  });

  it('uses a negative tone and a down arrow for a loss', () => {
    render(baseProps(BASE_QUOTE));
    const row = container.querySelector('.text-negative');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('▼');
  });

  it('uses a positive tone and an up arrow for a gain', () => {
    render(baseProps({ ...BASE_QUOTE, price: 74.2, change: 1.75, changePercent: 2.42 }));
    const row = container.querySelector('.text-positive');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('+1.75');
    expect(row?.textContent).toContain('(+2.42%)');
    expect(row?.textContent).toContain('▲');
  });

  it('shows a neutral grey zero change with no arrow', () => {
    render(baseProps({ ...BASE_QUOTE, price: 72.45, change: 0, changePercent: 0 }));
    const row = changeRow();
    expect(row?.className).toContain('text-text-muted');
    expect(row?.textContent).toContain('0.00');
    expect(row?.textContent).toContain('(0.00%)');
    expect(row?.textContent).not.toContain('▲');
    expect(row?.textContent).not.toContain('▼');
  });

  it('hides the change only when neither a provider change nor a real base exists', () => {
    render(baseProps({ ...BASE_QUOTE, previousClose: null, change: null, changePercent: null }));
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).not.toContain('(-3.73%)');
    expect(changeRow()).toBeNull();
  });

  it('converts only the change amount to THB and leaves the percentage untouched', () => {
    const fxQuote: FxQuote = {
      base: 'USD', quote: 'THB', rate: '36.50', asOf: '2026-07-23T14:00:00.000Z',
      fetchedAt: '2026-07-23T14:00:00.000Z', source: 'test', cached: false, stale: false,
    };
    render(baseProps(BASE_QUOTE, { fxQuote }));
    // Click the THB toggle.
    const thbButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'THB');
    expect(thbButton).toBeDefined();
    act(() => { thbButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const row = container.querySelector('.text-negative');
    // -2.70 USD × 36.50 = -98.55 THB (amount converts) but the percent is unchanged.
    expect(row?.textContent).toContain('-98.55');
    expect(row?.textContent).toContain('(-3.73%)');
    expect(row?.textContent).not.toContain('-2.70');
  });

  it('compares an extended-hours price against the regular close, not the previous close', () => {
    const extendedQuote = {
      session: 'after-hours' as const,
      price: 70.75,
      asOf: '2026-07-23T20:05:00.000Z',
      freshness: FRESHNESS,
      provider: 'polygon',
    };
    render(baseProps(BASE_QUOTE, { extendedQuote }));
    // Extended change = 70.75 − 69.75 (regular close) = +1.00, not vs 72.45.
    expect(container.textContent).toContain('+1.00');
  });

  it('renders a pre-market accepted quote in the labelled secondary row', () => {
    render(baseProps(BASE_QUOTE, {
      market: { currentStatus: 'pre-market' as const, notes: null },
      extendedQuote: {
        session: 'premarket' as const,
        price: 70.25,
        asOf: '2026-07-23T12:25:45.000Z',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
    }));
    const row = container.querySelector('[data-testid="extended-hours-row"]');
    expect(row?.textContent).toContain('ก่อนตลาดเปิด');
    expect(row?.textContent).toContain('70.25');
  });

  it('keeps the main status closed while showing the latest after-hours row', () => {
    render(baseProps(BASE_QUOTE, {
      market: { currentStatus: 'closed' as const, notes: null },
      extendedQuote: {
        session: 'after-hours' as const,
        price: 70.75,
        asOf: '2026-07-23T20:05:45.000Z',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
      realtime: true,
      feed: 'iex',
    }));
    const row = container.querySelector('[data-testid="extended-hours-row"]');
    expect(container.textContent).toContain('ปิดตลาด');
    expect(row?.textContent).toContain('หลังเวลาทำการ');
    expect(row?.textContent).toContain('+1.00');
    expect(container.textContent).not.toContain('Real-time · IEX');
  });

  it('cleanly hides the secondary row when closed without an extended quote', () => {
    render(baseProps(BASE_QUOTE, {
      market: { currentStatus: 'closed' as const, notes: null },
      extendedQuote: null,
    }));
    expect(container.textContent).toContain('ปิดตลาด');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
  });
});
