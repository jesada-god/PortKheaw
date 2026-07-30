// @vitest-environment jsdom

/**
 * Layout guards for the {@link StockPriceHeader} price line across viewport
 * widths (320px, 375px and desktop). jsdom has no CSS layout engine, so these
 * tests assert the DOM STRUCTURE and utility classes that make the required
 * responsive behaviour possible rather than measuring pixels:
 *
 *  - price + currency live in one wrapper, so a narrow-width wrap can only ever
 *    drop the change onto a second line — the USD/THB label can never be orphaned;
 *  - the change block is a SEPARATE sibling of that wrapper, so it wraps below the
 *    price when there is no room and sits beside it when there is;
 *  - order is price → currency → change (amount, percent, arrow);
 *  - price, currency and each change token are nowrap/tabular, while the change
 *    group can move below the price group as one unit on narrow screens;
 *  - colour + arrow follow the sign (unchanged from before).
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import type { CurrentMarketSession } from '@/src/lib/market-data/current-session';
import type { SnapshotExtendedInput } from '@/src/lib/market-data/market-snapshot';
import { quoteResource, sessionResult, snapshotOf } from '@/src/test/fixtures/market-snapshot';
import { buildStockPriceHeaderModel } from './price-header';
import { StockPriceHeader } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

const FRESHNESS: DataFreshness = { status: 'delayed', asOf: '2026-07-23T14:30:00.000Z', maxAgeSeconds: 900 };

const EVALUATED_AT = '2026-07-23T14:31:00.000Z';

const BASE_QUOTE: Quote = {
  symbol: 'RKLB', currency: 'USD', price: 69.75, open: 70.49, high: 72.94, low: 69.25,
  previousClose: 69.12, regularClose: 69.75, previousRegularClose: 69.12,
  change: 0.63, changePercent: 0.9115, volume: 21_031_353, latestTradingDay: '2026-07-23',
  quoteTimestamp: '2026-07-23T14:30:00.000Z',
};

function baseProps(quote: Quote | null, extra: Record<string, unknown> = {}) {
  return {
    symbol: 'RKLB', exchange: 'NASDAQ', sourceCurrency: 'USD',
    model: buildStockPriceHeaderModel({
      snapshot: snapshotOf({
        symbol: 'RKLB',
        session: sessionResult('REGULAR', { evaluatedAt: EVALUATED_AT, exchangeDate: '2026-07-23' }),
        quote: quoteResource(quote, FRESHNESS),
      }),
      evaluatedAt: EVALUATED_AT,
    }),
    providerConfigured: true,
    quoteError: null, quoteLoading: false, quoteRetryAt: 0, onRetryQuote: () => {},
    fxQuote: null as FxQuote | null, evaluatedAt: '2026-07-23T14:31:00.000Z', connectionState: null, ...extra,
  };
}

/**
 * Props whose model carries a REAL extended-hours print, so the second row is
 * rendered by the resolver rather than forced. PRE and POST are the only two
 * phases that have one, and both are exercised at every width.
 */
function extendedRowProps(session: Extract<CurrentMarketSession, 'PREMARKET' | 'AFTER_HOURS'>) {
  const premarket = session === 'PREMARKET';
  // 08:25 ET on the 23rd for PRE; 16:25 ET on the 23rd for POST.
  const printAt = premarket ? '2026-07-23T12:25:00.000Z' : '2026-07-23T20:25:00.000Z';
  const now = premarket ? '2026-07-23T12:30:00.000Z' : '2026-07-23T20:30:00.000Z';
  // Before the bell the completed close is the 22nd's; after it, the 23rd's.
  const closeAt = premarket ? '2026-07-22T20:00:00.000Z' : '2026-07-23T20:00:00.000Z';
  const quote: Quote = {
    ...BASE_QUOTE,
    latestTradingDay: premarket ? '2026-07-22' : '2026-07-23',
    quoteTimestamp: closeAt,
  };
  const extended: SnapshotExtendedInput = {
    session: premarket ? 'premarket' : 'after-hours',
    // Deliberately the widest realistic shape: six figures at full precision.
    price: 1_234_567.8912,
    asOf: printAt,
    tradingDate: '2026-07-23',
    freshness: { status: 'delayed', asOf: printAt, maxAgeSeconds: 900 },
    provider: 'yahoo-finance-chart',
  };
  return {
    ...baseProps(quote),
    model: buildStockPriceHeaderModel({
      snapshot: snapshotOf({
        symbol: 'RKLB',
        session: sessionResult(session, { evaluatedAt: now, exchangeDate: '2026-07-23' }),
        quote: quoteResource(quote, { status: 'end-of-day', asOf: closeAt, maxAgeSeconds: null }),
        extended,
        now,
      }),
      evaluatedAt: now,
    }),
    evaluatedAt: now,
  };
}

function extendedRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-testid="extended-hours-row"]');
  if (!row) throw new Error('extended-hours row not found');
  return row;
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

function renderAt(width: number, props: Record<string, unknown>) {
  (window as unknown as { innerWidth: number }).innerWidth = width;
  container.style.width = `${width}px`;
  act(() => { window.dispatchEvent(new Event('resize')); });
  act(() => { root.render(React.createElement(StockPriceHeader, props as never)); });
}

/** The `font-mono tabular-nums` price line is the first such row (the bid/ask book
 *  row, also tabular-nums, renders later and only when a stream supplies a book). */
function priceRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>('.tabular-nums');
  if (!row) throw new Error('price row not found');
  return row;
}
function priceCurrencyGroup(): HTMLElement { return priceRow().firstElementChild as HTMLElement; }
function currencyEl(): HTMLElement { return priceCurrencyGroup().lastElementChild as HTMLElement; }
function priceEl(): HTMLElement { return priceCurrencyGroup().firstElementChild as HTMLElement; }
function changeRow(): HTMLElement | null { return container.querySelector('div.text-base.font-semibold'); }

const WIDTHS: Array<[label: string, width: number]> = [
  ['mobile 320px', 320],
  ['mobile 375px', 375],
  ['desktop 1280px', 1280],
];

describe('StockPriceHeader price-line layout', () => {
  for (const [label, width] of WIDTHS) {
    describe(label, () => {
      it('keeps the currency beside the price and the change as a separate wrappable sibling', () => {
        renderAt(width, baseProps(BASE_QUOTE));
        const group = priceCurrencyGroup();
        const change = changeRow();

        // Price and currency share the same wrapper → the currency can never
        // become its own line, at any width.
        expect(group.contains(priceEl())).toBe(true);
        expect(group.contains(currencyEl())).toBe(true);
        expect(currencyEl().textContent).toBe('USD');
        expect(priceEl().textContent).toContain('69.75');

        // The change is a sibling of the group (not inside it), so it can wrap to a
        // second line on narrow widths without dragging the currency along.
        expect(change).not.toBeNull();
        expect(group.contains(change!)).toBe(false);
        expect(change!.parentElement).toBe(priceRow());
      });

      it('orders the line price → currency → change amount → percent → arrow', () => {
        renderAt(width, baseProps(BASE_QUOTE));
        const text = priceRow().textContent ?? '';
        const iPrice = text.indexOf('69.75');
        const iCurrency = text.indexOf('USD');
        const iAmount = text.indexOf('+0.63');
        const iPercent = text.indexOf('(+0.91%)');
        expect(iPrice).toBeGreaterThanOrEqual(0);
        expect(iCurrency).toBeGreaterThan(iPrice);
        expect(iAmount).toBeGreaterThan(iCurrency);
        expect(iPercent).toBeGreaterThan(iAmount);
        // Gain keeps the green tone and up arrow.
        const positive = priceRow().querySelector('.text-positive');
        expect(positive).not.toBeNull();
        expect(positive!.textContent).toContain('▲');
      });

      it('never splits the numeric price or currency at a mobile line boundary', () => {
        renderAt(width, baseProps({ ...BASE_QUOTE, price: 1_234_567.891, change: 12.5, changePercent: 1.02 }));
        expect(priceRow().className).toContain('tabular-nums');
        expect(priceEl().className).toContain('whitespace-nowrap');
        expect(priceEl().className).not.toContain('break-words');
        expect(priceEl().className).not.toContain('break-all');
        expect(priceEl().className).not.toContain('[overflow-wrap:anywhere]');
        expect(currencyEl().className).toContain('whitespace-nowrap');
        expect(currencyEl().className).toContain('shrink-0');
        expect(currencyEl().textContent).toBe('USD');
        expect(changeRow()?.className).toContain('whitespace-nowrap');
      });
    });
  }

  /**
   * The second row appears in PRE and POST. Its content is longer than the main
   * line's — session label, price, change, percent, date and a provenance line — so
   * it is the row most at risk of pushing the page wide on a 320px screen.
   *
   * The structure that prevents that: one `flex-wrap` container with `min-w-0`, in
   * which every numeric token is `whitespace-nowrap` and `shrink-0`. Tokens
   * therefore move to a new line as whole units instead of either splitting a
   * number or forcing the row wider than its parent. The status line is `basis-full`
   * so the longest text in the row always starts on a line of its own.
   */
  for (const [label, width] of WIDTHS) {
    for (const session of ['PREMARKET', 'AFTER_HOURS'] as const) {
      it(`wraps the ${session} extended row within its container at ${label}`, () => {
        renderAt(width, extendedRowProps(session));
        const row = extendedRow();
        expect(row.className).toContain('flex-wrap');
        expect(row.className).toContain('min-w-0');
        // Nothing in the row may grow past the header, at any width.
        expect(row.className).not.toContain('w-[');
        expect(row.className).not.toContain('overflow-x');

        const price = container.querySelector<HTMLElement>('[data-testid="extended-hours-price"]')!;
        const change = container.querySelector<HTMLElement>('[data-testid="extended-hours-change"]')!;
        expect(price.className).toContain('whitespace-nowrap');
        expect(price.className).toContain('shrink-0');
        expect(change.className).toContain('whitespace-nowrap');
        expect(change.className).toContain('shrink-0');
        // Every token is a direct child of the wrapping row, so each one can move
        // to the next line independently rather than dragging the group along.
        for (const token of [price, change]) expect(token.parentElement).toBe(row);
        // The provenance line takes a full row of its own, never trailing the price.
        expect(container.querySelector('[data-testid="extended-hours-status"]')?.className)
          .toContain('basis-full');
      });
    }
  }

  it('keeps the main price row unchanged when the extended row is present', () => {
    renderAt(320, extendedRowProps('AFTER_HOURS'));
    // The close, not the 1,234,567.8912 print above it — the two rows stay separate.
    expect(priceEl().textContent).toBe('69.75');
    expect(currencyEl().textContent).toBe('USD');
    expect(priceCurrencyGroup().contains(currencyEl())).toBe(true);
  });

  it('renders a loss with the red tone and a down arrow (colours unchanged)', () => {
    renderAt(375, baseProps({ ...BASE_QUOTE, price: 66.0, change: -3.12, changePercent: -4.51 }));
    const negative = priceRow().querySelector('.text-negative');
    expect(negative).not.toBeNull();
    expect(negative!.textContent).toContain('-3.12');
    expect(negative!.textContent).toContain('▼');
  });

  it('keeps the currency beside the price even when there is no change to show', () => {
    // The previous-close fallback with a single close: price + currency only, no
    // change block — the currency must still sit in the group beside the price.
    renderAt(320, baseProps({ ...BASE_QUOTE, previousClose: null, previousRegularClose: null, change: null, changePercent: null }));
    expect(changeRow()).toBeNull();
    expect(priceCurrencyGroup().contains(currencyEl())).toBe(true);
    expect(currencyEl().textContent).toBe('USD');
    expect(priceEl().textContent).toContain('69.75');
  });

  /**
   * The headline shows the price at the precision the exchange printed it, capped at
   * four decimals and with trailing zeros dropped.
   *
   * This is deliberately not 2-decimal rounding. NVTS's official regular close is
   * 9.735, and a headline reading 9.74 is exactly the "the main price does not match
   * the real close" complaint. The stored quote is never altered either way.
   */
  it('shows the exchange precision in the main price without changing the stored quote', () => {
    const quote = { ...BASE_QUOTE, price: 9.735, regularClose: 9.735 };
    renderAt(375, baseProps(quote));
    expect(priceEl().textContent).toBe('9.735');
    expect(quote.price).toBe(9.735);
  });

  it('keeps an ordinary two-decimal close unchanged', () => {
    renderAt(375, baseProps({ ...BASE_QUOTE, price: 206.87, regularClose: 206.87 }));
    expect(priceEl().textContent).toBe('206.87');
  });

  it('caps a noisy value at four decimals rather than printing full float precision', () => {
    renderAt(375, baseProps({ ...BASE_QUOTE, price: 10.045_812_3, regularClose: 10.045_812_3 }));
    expect(priceEl().textContent).toBe('10.0458');
  });
});
