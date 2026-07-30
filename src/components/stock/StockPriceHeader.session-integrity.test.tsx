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
 * `resolveCanonicalMarketSnapshot` → `buildStockPriceHeaderModel` →
 * `StockPriceHeader` — so a regression anywhere along it fails here.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySymbolHalt,
  resolveCurrentMarketSession,
  sessionPhaseOf,
} from '@/src/lib/market-data/current-session';
import type { Quote } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import { resolveCanonicalMarketSnapshot, type SnapshotExtendedInput } from '@/src/lib/market-data/market-snapshot';
import { buildStockPriceHeaderModel } from './price-header';
import { StockPriceHeader } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

/** Friday 2026-07-24 16:00 ET — the completed regular close in the screenshot. */
const FRIDAY_CLOSE = '2026-07-24T20:00:00.000Z';
/** Friday 19:55 ET — the after-hours print in the screenshot's secondary row. */
const FRIDAY_AFTER_HOURS = '2026-07-24T23:55:00.000Z';
/** Friday 19:56 ET — inside the after-hours window that print belongs to. */
const FRIDAY_POST = '2026-07-24T23:56:00.000Z';
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

const FRIDAY_EXTENDED: SnapshotExtendedInput = {
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
  serverExtendedQuote?: SnapshotExtendedInput | null;
  connectionState?: 'connected' | 'awaiting-data' | null;
}) {
  const resolved = resolveCurrentMarketSession({
    now: options.now,
    marketStatus: options.providerStatus ?? null,
    holidays: options.holidays,
  });
  const currentSession = applySymbolHalt(resolved.session, options.halted ?? false);
  const current = quoteResource(FRIDAY_CLOSE);
  const snapshot = resolveCanonicalMarketSnapshot({
    symbol: 'AAPL',
    session: { ...resolved, session: currentSession, phase: sessionPhaseOf(currentSession) },
    quote: current,
    initialQuote: current,
    extended: options.serverExtendedQuote ?? null,
    now: options.now,
  });
  const model = buildStockPriceHeaderModel({ snapshot, evaluatedAt: options.now });
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
  return { resolved, currentSession, model, snapshot };
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
  /**
   * The screenshot's Sunday, corrected on both counts: the session reads ปิดตลาด,
   * and Friday's after-hours print is gone. By Sunday that print is two days old and
   * its window has long closed, so a reader has no way to tell it from a current
   * one — which is exactly what makes showing it a lie rather than extra detail.
   */
  it('reproduces the production screenshot correctly: ปิดตลาด with one row', () => {
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
    expect(sessionLabel()).toContain('ปิดตลาด');
    expect(sessionLabel()).not.toContain('ตลาดเปิด');
    // The primary row is the latest completed regular close…
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    expect(container.querySelector('[data-testid="regular-change"]')?.textContent).toContain('-1.89');
    // …and it is the ONLY row.
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
    expect(container.textContent).not.toContain('206.7995');
    // The main line dates the DATA, never the session.
    expect(container.querySelector('[data-testid="session-line"]')?.textContent).toContain('ข้อมูลล่าสุด 24/07');
  });

  /** The same print, inside the window it belongs to: row shown, close untouched. */
  it('shows that print in the second row while the after-hours window is open', () => {
    const { currentSession } = renderChain({
      now: FRIDAY_POST,
      serverExtendedQuote: FRIDAY_EXTENDED,
    });

    expect(currentSession).toBe('AFTER_HOURS');
    expect(sessionLabel()).toContain('หลังปิดตลาด');
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    const extended = container.querySelector('[data-testid="extended-hours-row"]');
    expect(extended?.textContent).toContain('หลังปิดตลาด');
    expect(extended?.textContent).toContain('206.7995');
    expect(extended?.textContent).toContain('-0.0705');
    expect(container.querySelector('[data-testid="extended-hours-date"]')?.textContent).toBe('24/07');
  });

  it('E: a Friday quote timestamp cannot make Sunday look open', () => {
    const { currentSession } = renderChain({ now: SUNDAY });
    expect(currentSession).toBe('CLOSED');
    expect(sessionLabel()).not.toContain('ตลาดเปิด');
  });

  it('F: a connected socket on a weekend does not imply an open market', () => {
    renderChain({ now: SUNDAY, connectionState: 'awaiting-data' });
    expect(container.textContent).toContain('เชื่อมต่อแล้ว · รอข้อมูลสด');
    expect(sessionLabel()).toContain('ปิดตลาด');
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
    expect(sessionLabel()).toContain('วันหยุด');
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
    expect(container.textContent).not.toContain('หลังปิดตลาด');
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
    expect(sessionLabel()).not.toContain('ปิดตลาด');
  });

  /**
   * Before the bell the main row is Friday's official close and the pre-market print
   * sits beneath it, measured from that close. The print is a different DOMAIN, not
   * a fresher version of the same number: promoting it overwrites a finalized
   * regular value with an extended one, which is the defect in the other direction.
   */
  it('keeps the completed close on the main row before the open', () => {
    const { currentSession, snapshot } = renderChain({
      // Monday 2026-07-27, 08:00 ET.
      now: '2026-07-27T12:00:00.000Z',
      // Monday's OWN pre-market print, 07:45 ET. It follows Friday's close, so
      // it never shares a trading date with that close.
      serverExtendedQuote: {
        ...FRIDAY_EXTENDED,
        session: 'premarket',
        price: 208.1,
        asOf: '2026-07-27T11:45:00.000Z',
        tradingDate: '2026-07-27',
      },
    });
    expect(currentSession).toBe('PREMARKET');
    expect(sessionLabel()).toContain('ก่อนเปิดตลาด');
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    expect(snapshot.mainPriceRole).toBe('regular-close');
    // Compared against the previous regular close (208.76).
    expect(snapshot.comparisonBase).toBe(208.76);
    expect(snapshot.comparisonBaseKind).toBe('previous-regular-close');
    // The print takes the second row, compared against the close above it:
    // 208.10 − 206.87 = +1.23.
    const extended = container.querySelector('[data-testid="extended-hours-row"]');
    expect(extended?.getAttribute('data-extended-session')).toBe('premarket');
    expect(container.querySelector('[data-testid="extended-hours-price"]')?.textContent).toBe('208.10');
    expect(container.querySelector('[data-testid="extended-hours-change"]')?.textContent).toContain('+1.23');
    expect(container.querySelector('[data-testid="extended-hours-date"]')?.textContent).toBe('27/07');
  });

  it("refuses yesterday's pre-market print in this morning's row", () => {
    renderChain({
      now: '2026-07-27T12:00:00.000Z',
      // Friday's pre-market print, still held by the pipeline over the weekend.
      serverExtendedQuote: {
        ...FRIDAY_EXTENDED,
        session: 'premarket',
        price: 210.4,
        asOf: '2026-07-24T11:45:00.000Z',
        tradingDate: '2026-07-24',
      },
    });
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
    expect(container.textContent).not.toContain('210.40');
  });

  it('keeps no raw provider status or debug wording in the primary UI', () => {
    renderChain({ now: FRIDAY_POST, serverExtendedQuote: FRIDAY_EXTENDED });
    const section = container.querySelector('section')?.textContent ?? '';
    const primarySessionLine = container.querySelector('[data-testid="session-line"]')?.textContent ?? '';
    expect(section).not.toContain('ราคาปิด intraday ล่าสุด');
    expect(primarySessionLine).not.toContain('exchange-calendar');
    expect(primarySessionLine).not.toContain('polygon');
    // Extended provenance is intentionally compact and visible in its own row.
    expect(container.querySelector('[data-testid="extended-hours-status"]')?.textContent)
      .toContain('yahoo-finance-chart');
    expect(section).not.toContain('CLOSED');
  });
});
