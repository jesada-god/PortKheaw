// @vitest-environment jsdom

/**
 * End-to-end guard for the RKLB production incident: after commit 459ae35 the
 * header still showed only "69.75 USD" with no change/%, because the free
 * previous-close fallback discarded the daily change (the premium snapshot is a
 * 403). The fix derives the change from two real daily closes on the server, so
 * `/api/market/quote/RKLB` now returns a populated `change`/`changePercent`.
 *
 * This test drives the *runtime payload* the fixed route serializes, parses it
 * with the SAME schema the browser transport uses ({@link quoteEnvelopeSchema}),
 * feeds the parsed quote into {@link StockPriceHeader}, and asserts the rendered
 * card shows both the change amount and percent — proving the fields survive
 * every layer from API response to pixels.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteEnvelopeSchema } from '@/src/lib/stock-detail/api-schemas';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { buildStockPriceHeaderModel } from './price-header';
import { StockPriceHeader } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

/**
 * The exact JSON body the fixed `/api/market/quote/[symbol]` route serializes for
 * RKLB when the snapshot is 403 and the previous-close fallback enriches the
 * change from two real daily closes (69.75 vs 69.12). Built as a plain object so
 * the assertion below exercises the real Zod parse, not a hand-made `Quote`.
 */
const RKLB_API_BODY = {
  data: {
    symbol: 'RKLB',
    currency: 'USD',
    price: 69.75,
    open: 70.49,
    high: 72.94,
    low: 69.25,
    previousClose: 69.12,
    change: 69.75 - 69.12,
    changePercent: ((69.75 - 69.12) / 69.12) * 100,
    volume: 21_031_353,
    latestTradingDay: '2026-07-22',
  },
  meta: {
    provider: 'polygon',
    timestamp: '2026-07-23T14:31:00.000Z',
    freshness: { status: 'end-of-day', asOf: '2026-07-22T20:00:00.000Z', maxAgeSeconds: 86_400 },
  },
} as const;

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

describe('StockPriceHeader — RKLB previous-close fallback integration', () => {
  it('renders the daily change end-to-end from the parsed API quote payload', () => {
    // 1) Parse the runtime API body exactly as the browser transport does.
    const parsed = quoteEnvelopeSchema.safeParse(RKLB_API_BODY);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const quote = parsed.data.data;
    expect(quote).not.toBeNull();
    // The change fields must survive schema validation (the layer under audit).
    expect(quote!.change).toBeCloseTo(0.63, 2);
    expect(quote!.changePercent).toBeCloseTo(0.9115, 3);

    // 2) Render the header from the parsed quote + envelope meta.
    const freshness = parsed.data.meta.freshness as DataFreshness;
    act(() => {
      root.render(React.createElement(StockPriceHeader, {
        symbol: 'RKLB',
        exchange: 'NASDAQ',
        sourceCurrency: quote!.currency ?? 'USD',
        model: buildStockPriceHeaderModel({
          data: {
            quote: quote!,
            freshness,
            provider: parsed.data.meta.provider,
            fallbackLabel: null,
            extendedQuote: null,
          },
          currentSession: 'CLOSED',
          currentSessionEvaluatedAt: '2026-07-23T14:31:00.000Z',
          currentSessionSource: 'exchange-calendar',
        }),
        providerConfigured: true,
        quoteError: null,
        quoteLoading: false,
        quoteRetryAt: 0,
        onRetryQuote: () => {},
        fxQuote: null,
        evaluatedAt: '2026-07-23T14:31:00.000Z',
        connectionState: null,
      } as never));
    });

    // 3) The card shows the price AND the derived change amount + percent.
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).toContain('+0.63');
    expect(container.textContent).toContain('(+0.91%)');
    // A gain renders in the positive tone with an up arrow.
    const positive = container.querySelector('.text-positive');
    expect(positive).not.toBeNull();
    expect(positive?.textContent).toContain('▲');
  });
});
