// @vitest-environment jsdom

/**
 * End-to-end guard for the production "ตลาดเปิด on a closed market" defect.
 *
 * The header showed:
 *
 *     206.87 USD  −1.89 (−0.91%)
 *     ☀️ ตลาดเปิด · 24/07          ← wrong: this was a completed session
 *     🌙 หลังเวลาทำการ  206.7995 …  ← and it was rendered at the same time
 *
 * Two separate lies, one root cause: the current session was inferred from a
 * PRICE (the accepted trade's own timestamp classified as `regular`) rather than
 * from the clock and a verified market-status report.
 *
 * These tests drive the real chain — `resolveCurrentMarketSession` →
 * `resolvePriceHeaderData` → `buildStockPriceHeaderModel` → `StockPriceHeader` —
 * so a regression anywhere along it fails here.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCurrentMarketSession, applySymbolHalt } from '@/src/lib/market-data/current-session';
import type { Quote } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import {
  buildStockPriceHeaderModel,
  resolvePriceHeaderData,
  type PriceHeaderExtendedQuote,
} from './price-header';
import { StockPriceHeader } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

/** Friday 2026-07-24 16:00 ET — the completed regular close in the screenshot. */
const FRIDAY_CLOSE = '2026-07-24T20:00:00.000Z';
/** Friday 19:55 ET — the after-hours print in the screenshot's secondary row. */
const FRIDAY_AFTER_HOURS = '2026-07-24T23:55:00.000Z';
/** Sunday 2026-07-26 13:00 ET — the moment the screenshot was taken. */
const SUNDAY = '2026-07-26T17:00:00.000Z';
/** Friday 13:00 ET — when the market-status provider last said "open". */
const FRIDAY_STATUS_ASOF = '2026-07-24T17:00:00.000Z';

const FRIDAY_QUOTE: Quote = {
  symbol: 'AAPL',
  currency: 'USD',
  price: 206.87,
  open: 208.1,
  high: 209.4,
  low: 206.2,
  previousClose: 208.76,
  regularClose: 206.87,
  previousRegularClose: 208.76,
  change: -1.89,
  changePercent: -0.91,
  volume: 41_000_000,
  latestTradingDay: '2026-07-24',
};

const FRIDAY_EXTENDED: PriceHeaderExtendedQuote = {
  session: 'after-hours',
  price: 206.7995,
  asOf: FRIDAY_AFTER_HOURS,
  tradingDate: '2026-07-24',
  freshness: { status: 'delayed', asOf: FRIDAY_AFTER_HOURS, maxAgeSeconds: null },
  provider: 'yahoo-finance-chart',
};

function quoteResource(asOf: string): StockDetailQuoteResource {
  return {
    data: FRIDAY_QUOTE,
    freshness: { status: 'end-of-day', asOf, maxAgeSeconds: null },
    provider: 'polygon',
    reason: null,
    error: null,
    fallbackLabel: null,
  };
}

/** The full production chain, from a wall-clock instant to rendered props. */
function renderChain(options: {
  now: string;
  providerStatus?: Parameters<typeof resolveCurrentMarketSession>[0]['marketStatus'];
  holidays?: ReadonlySet<string>;
  halted?: boolean;
  serverExtendedQuote?: PriceHeaderExtendedQuote | null;
  connectionState?: 'connected' | 'awaiting-data' | null;
}) {
  const resolved = resolveCurrentMarketSession({
    now: options.now,
    marketStatus: options.providerStatus ?? null,
    holidays: options.holidays,
  });
  const currentSession = applySymbolHalt(resolved.session, options.halted ?? false);
  const current = quoteResource(FRIDAY_CLOSE);
  const data = resolvePriceHeaderData({
    current,
    initial: current,
    currentSession,
    evaluatedAt: options.now,
    serverExtendedQuote: options.serverExtendedQuote ?? null,
  });
  const model = buildStockPriceHeaderModel({
    data,
    currentSession,
    currentSessionEvaluatedAt: resolved.evaluatedAt,
    currentSessionSource: resolved.source,
  });
  act(() => {
    root.render(React.createElement(StockPriceHeader, {
      symbol: 'AAPL',
      exchange: 'NASDAQ',
      sourceCurrency: 'USD',
      model,
      providerConfigured: true,
      quoteError: null,
      quoteLoading: false,
      quoteRetryAt: 0,
      onRetryQuote: () => {},
      fxQuote: null,
      evaluatedAt: options.now,
      connectionState: options.connectionState ?? null,
    } as never));
  });
  return { resolved, currentSession, model };
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

function sessionLabel(): string {
  return container.querySelector('[data-testid="current-session-label"]')?.textContent ?? '';
}

describe('Stock price header — current market session integrity', () => {
  it('reproduces the production screenshot correctly: ตลาดปิด with a dated after-hours row', () => {
    const { currentSession } = renderChain({
      now: SUNDAY,
      // The exact stale evidence that produced the bug: Friday's "open".
      providerStatus: {
        status: 'open',
        asOf: FRIDAY_STATUS_ASOF,
        source: 'polygon-market-status',
        stale: false,
        maxAgeSeconds: 30,
      },
      serverExtendedQuote: FRIDAY_EXTENDED,
    });

    expect(currentSession).toBe('CLOSED');
    expect(sessionLabel()).toContain('ตลาดปิด');
    expect(sessionLabel()).not.toContain('ตลาดเปิด');
    // The primary row stays the latest completed regular close…
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    expect(container.querySelector('[data-testid="regular-change"]')?.textContent).toContain('-1.89');
    // …and the after-hours row is allowed, carrying its own trading date.
    const extended = container.querySelector('[data-testid="extended-hours-row"]');
    expect(extended?.textContent).toContain('หลังเวลาทำการ');
    expect(extended?.textContent).toContain('206.7995');
    expect(extended?.textContent).toContain('-0.0705');
    expect(container.querySelector('[data-testid="extended-hours-date"]')?.textContent).toBe('24/07');
    // The main line dates the DATA, never the session.
    expect(container.querySelector('[data-testid="session-line"]')?.textContent).toContain('ข้อมูลล่าสุด 24/07');
  });

  it('E: a Friday quote timestamp cannot make Sunday look open', () => {
    const { currentSession } = renderChain({ now: SUNDAY });
    expect(currentSession).toBe('CLOSED');
    expect(sessionLabel()).not.toContain('ตลาดเปิด');
  });

  it('F: a connected socket on a weekend does not imply an open market', () => {
    renderChain({ now: SUNDAY, connectionState: 'awaiting-data' });
    expect(container.textContent).toContain('เชื่อมต่อแล้ว · รอข้อมูลสด');
    expect(sessionLabel()).toContain('ตลาดปิด');
  });

  it('H: a cached "open" cannot override a verified holiday', () => {
    const { currentSession } = renderChain({
      now: '2026-07-27T17:00:00.000Z',
      holidays: new Set(['2026-07-27']),
      providerStatus: {
        status: 'open',
        asOf: '2026-07-27T17:00:00.000Z',
        source: 'polygon-market-status',
        stale: false,
        maxAgeSeconds: 30,
      },
    });
    expect(currentSession).toBe('HOLIDAY');
    expect(sessionLabel()).toContain('วันหยุดตลาด');
    expect(sessionLabel()).not.toContain('ตลาดเปิด');
  });

  it('A+B: an open market shows ตลาดเปิด and no extended row at all', () => {
    const { currentSession } = renderChain({
      // Monday 2026-07-27, 13:00 ET.
      now: '2026-07-27T17:00:00.000Z',
      providerStatus: {
        status: 'open',
        asOf: '2026-07-27T17:00:00.000Z',
        source: 'polygon-market-status',
        stale: false,
        maxAgeSeconds: 30,
      },
      // Offered, and correctly refused.
      serverExtendedQuote: FRIDAY_EXTENDED,
    });

    expect(currentSession).toBe('REGULAR');
    expect(sessionLabel()).toContain('ตลาดเปิด');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
    expect(container.textContent).not.toContain('หลังเวลาทำการ');
  });

  it('shows a halt without downgrading an open market to closed', () => {
    const { currentSession } = renderChain({
      now: '2026-07-27T17:00:00.000Z',
      providerStatus: {
        status: 'open',
        asOf: '2026-07-27T17:00:00.000Z',
        source: 'polygon-market-status',
        stale: false,
        maxAgeSeconds: 30,
      },
      halted: true,
    });
    expect(currentSession).toBe('HALTED');
    expect(sessionLabel()).toContain('หยุดซื้อขายชั่วคราว');
    expect(sessionLabel()).not.toContain('ตลาดปิด');
  });

  it('shows the pre-market row beside the previous regular close before the open', () => {
    const { currentSession } = renderChain({
      // Monday 2026-07-27, 08:00 ET.
      now: '2026-07-27T12:00:00.000Z',
      serverExtendedQuote: {
        ...FRIDAY_EXTENDED,
        session: 'premarket',
        price: 208.1,
        asOf: '2026-07-24T12:45:00.000Z',
        tradingDate: '2026-07-24',
      },
    });
    expect(currentSession).toBe('PREMARKET');
    expect(sessionLabel()).toContain('ก่อนตลาดเปิด');
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    expect(container.querySelector('[data-testid="extended-hours-row"]')?.textContent).toContain('208.10');
  });

  it('keeps no raw provider status or debug wording in the primary UI', () => {
    renderChain({ now: SUNDAY, serverExtendedQuote: FRIDAY_EXTENDED });
    const section = container.querySelector('section')?.textContent ?? '';
    expect(section).not.toContain('ราคาปิด intraday ล่าสุด');
    expect(section).not.toContain('exchange-calendar');
    expect(section).not.toContain('polygon');
    expect(section).not.toContain('yahoo-finance-chart');
    expect(section).not.toContain('CLOSED');
  });
});
