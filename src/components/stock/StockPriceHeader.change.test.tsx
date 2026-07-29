// @vitest-environment jsdom

/**
 * Behavioural guard for the daily-change display in {@link StockPriceHeader}.
 *
 * The header must render `change` + `changePercent` next to the price whenever a
 * truthful canonical previous close exists, and hide it when that base is
 * unavailable. Colour/arrow follow the sign; a USD/THB toggle converts the
 * change amount but never the percentage.
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
import { StockPriceHeader, type TransientPriceSink } from './StockPriceHeader';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

// 14:30Z is 10:30 ET on Thursday 2026-07-23 — inside the regular session, so a quote
// stamped here is a genuine live regular price rather than an extended print.
const FRESHNESS: DataFreshness = { status: 'delayed', asOf: '2026-07-23T14:30:00.000Z', maxAgeSeconds: 900 };
const EVALUATED_AT = '2026-07-23T14:31:00.000Z';

const BASE_QUOTE: Quote = {
  symbol: 'RKLB',
  currency: 'USD',
  price: 69.75,
  open: 71,
  high: 72,
  low: 69,
  previousClose: 72.45,
  regularClose: 69.75,
  previousRegularClose: 72.45,
  change: -2.7,
  changePercent: -3.73,
  volume: 1_000_000,
  latestTradingDay: '2026-07-23',
  quoteTimestamp: '2026-07-23T14:30:00.000Z',
};

/**
 * A plausible evaluation instant for each session on Thursday 2026-07-23 ET.
 *
 * The resolver validates a print against `now`, so a fixture claiming CLOSED while
 * evaluating at 10:31 ET would have every after-hours print rejected as
 * future-dated — correctly. Tests therefore evaluate inside the session they claim.
 */
const NOW_BY_SESSION: Partial<Record<CurrentMarketSession, string>> = {
  PREMARKET: '2026-07-23T12:30:00.000Z', // 08:30 ET
  REGULAR: EVALUATED_AT, //               10:31 ET
  HALTED: EVALUATED_AT,
  AFTER_HOURS: '2026-07-23T20:30:00.000Z', // 16:30 ET
  CLOSED: '2026-07-24T01:00:00.000Z', //     21:00 ET on the 23rd
  HOLIDAY: '2026-07-24T01:00:00.000Z',
};

/**
 * Builds the model the header renders, by driving the REAL canonical resolver.
 * The session is supplied explicitly — the component never infers one, which is
 * the whole point of the model boundary.
 */
function headerModel(
  quote: Quote | null,
  options: {
    currentSession?: CurrentMarketSession;
    extendedQuote?: SnapshotExtendedInput | null;
  } = {},
) {
  const session = options.currentSession ?? 'REGULAR';
  const now = NOW_BY_SESSION[session] ?? EVALUATED_AT;
  return buildStockPriceHeaderModel({
    snapshot: snapshotOf({
      symbol: 'RKLB',
      session: sessionResult(session, { evaluatedAt: now, exchangeDate: '2026-07-23' }),
      quote: quoteResource(quote, FRESHNESS),
      extended: options.extendedQuote ?? null,
      now,
    }),
    evaluatedAt: now,
  });
}

function baseProps(
  quote: Quote | null,
  extra: Record<string, unknown> = {},
  modelOptions: Parameters<typeof headerModel>[1] = {},
) {
  return {
    symbol: 'RKLB',
    exchange: 'NASDAQ',
    sourceCurrency: 'USD',
    model: headerModel(quote, modelOptions),
    providerConfigured: true,
    quoteError: null,
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
  it('updates live price/change/% atomically through the ref sink', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));

    expect(transientPriceSinkRef.current).not.toBeNull();
    // 14:32Z = 10:32 ET, inside the regular session the model is in.
    transientPriceSinkRef.current?.(70.1234, { asOf: '2026-07-23T14:32:00.000Z', feed: 'iex' });

    // The headline shows the tick's real precision, capped at four decimals.
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('70.1234');
    expect(container.querySelector('[data-testid="regular-change"]')?.textContent).toContain('-2.3266');
    expect(container.querySelector('[data-testid="regular-change"]')?.textContent).toContain('(-3.21%)');
  });

  /**
   * A tick with no exchange timestamp cannot be proved to belong to the regular
   * session, so the hot path refuses it rather than assuming. Assuming was the
   * defect: it is how an unlabelled Alpaca after-hours print reached this node.
   */
  it('refuses a transient tick that carries no exchange timestamp', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));

    transientPriceSinkRef.current?.(70.1234);

    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('69.75');
  });

  it('does not let an unrelated React render overwrite the latest transient price', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));
    transientPriceSinkRef.current?.(206.87, {
      asOf: '2026-07-23T14:33:00.000Z',
      feed: 'iex',
    });

    render(baseProps({ ...BASE_QUOTE, price: 212.06, regularClose: 212.06 }, {
      transientPriceSinkRef,
      connectionState: 'connected',
    }));

    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('206.87');
  });

  it('never lets a transient extended-hours trade overwrite the main regular row', () => {
    const transientPriceSinkRef: { current: TransientPriceSink | null } = { current: null };
    render(baseProps(BASE_QUOTE, { transientPriceSinkRef }));

    transientPriceSinkRef.current?.(70.75, {
      asOf: '2026-07-23T20:05:00.000Z',
      feed: 'finnhub',
      session: 'after-hours',
    });

    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('69.75');
  });

  it('renders change + percent from a REST quote with price and previous close', () => {
    // Provider omitted its own change: derive from the real previous close.
    render(baseProps({ ...BASE_QUOTE, change: null, changePercent: null }));
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).toContain('-2.70');
    expect(container.textContent).toContain('(-3.73%)');
  });

  it('hides provider change when the canonical previous close is missing', () => {
    render(baseProps({ ...BASE_QUOTE, previousClose: null, previousRegularClose: null }));
    expect(container.textContent).toContain('69.75');
    expect(container.textContent).not.toContain('(-3.73%)');
    expect(changeRow()).toBeNull();
  });

  it('uses a negative tone and a down arrow for a loss', () => {
    render(baseProps(BASE_QUOTE));
    const row = container.querySelector('.text-negative');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('▼');
  });

  it('uses a positive tone and an up arrow for a gain', () => {
    render(baseProps({ ...BASE_QUOTE, price: 74.2, regularClose: 74.2, change: 1.75, changePercent: 2.42 }));
    const row = container.querySelector('.text-positive');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('+1.75');
    expect(row?.textContent).toContain('(+2.42%)');
    expect(row?.textContent).toContain('▲');
  });

  it('shows a neutral grey zero change with no arrow', () => {
    render(baseProps({ ...BASE_QUOTE, price: 72.45, regularClose: 72.45, change: 0, changePercent: 0 }));
    const row = changeRow();
    expect(row?.className).toContain('text-text-muted');
    expect(row?.textContent).toContain('0.00');
    expect(row?.textContent).toContain('(0.00%)');
    expect(row?.textContent).not.toContain('▲');
    expect(row?.textContent).not.toContain('▼');
  });

  it('hides the change when no real base exists', () => {
    render(baseProps({ ...BASE_QUOTE, previousClose: null, previousRegularClose: null, change: null, changePercent: null }));
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
    render(baseProps(BASE_QUOTE, {}, {
      currentSession: 'AFTER_HOURS',
      extendedQuote: {
        session: 'after-hours',
        price: 70.75,
        asOf: '2026-07-23T20:05:00.000Z',
        tradingDate: '2026-07-23',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
    }));
    // Extended change = 70.75 − 69.75 (regular close) = +1.00, not vs 72.45.
    expect(container.textContent).toContain('+1.00');
  });

  /**
   * PRE promotes the pre-market print to the MAIN line — that IS the current price
   * before the bell, and showing yesterday's close there instead is what made the
   * header look frozen every morning. Because the print is the main line it is not
   * also duplicated into a secondary row.
   */
  it('makes the latest pre-market print the main price during PRE', () => {
    render(baseProps(BASE_QUOTE, {}, {
      currentSession: 'PREMARKET',
      extendedQuote: {
        session: 'premarket',
        price: 70.25,
        asOf: '2026-07-23T12:25:45.000Z',
        tradingDate: '2026-07-23',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
    }));
    expect(container.querySelector('[data-testid="stock-last-price"]')?.textContent).toBe('70.25');
    expect(container.textContent).toContain('ก่อนเปิดตลาด');
    // Compared against the previous regular close (72.45), not against 69.75.
    expect(container.querySelector('[data-testid="regular-change"]')?.textContent).toContain('-2.20');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="current-session-label"] [data-session-icon]')
      ?.getAttribute('data-session-icon')).toBe('wb_twilight');
  });

  it('keeps the main status closed while showing the latest after-hours row', () => {
    render(baseProps(BASE_QUOTE, { realtime: true, feed: 'iex' }, {
      currentSession: 'CLOSED',
      extendedQuote: {
        session: 'after-hours',
        price: 70.75,
        asOf: '2026-07-23T20:05:45.000Z',
        tradingDate: '2026-07-23',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
    }));
    const row = container.querySelector('[data-testid="extended-hours-row"]');
    expect(container.textContent).toContain('ปิดตลาด');
    expect(container.textContent).not.toContain('ตลาดเปิด');
    expect(row?.textContent).toContain('หลังปิดตลาด');
    expect(row?.textContent).toContain('+1.00');
    expect(row?.querySelector('[data-session-icon]')).not.toBeNull();
    expect(container.textContent).not.toContain('Real-time · IEX');
  });

  it.each([
    ['delayed', 'ราคาล่าช้า'],
    ['stale', 'ข้อมูลอาจล่าช้า'],
    ['cached', 'ข้อมูลที่บันทึกไว้'],
  ] as const)('keeps the extended row visible with the %s Thai status', (status, label) => {
    render(baseProps(BASE_QUOTE, {}, {
      currentSession: 'CLOSED',
      extendedQuote: {
        session: 'after-hours',
        price: 70.75,
        asOf: '2026-07-23T20:05:45.000Z',
        tradingDate: '2026-07-23',
        freshness: { status, asOf: '2026-07-23T20:05:45.000Z', maxAgeSeconds: null },
        provider: 'polygon',
      },
    }));
    expect(container.querySelector('[data-testid="extended-hours-row"]')).not.toBeNull();
    const statusLine = container.querySelector('[data-testid="extended-hours-status"]');
    expect(statusLine?.textContent).toContain(label);
    expect(statusLine?.textContent).toContain('polygon');
  });

  it('renders a valid extended price even when its comparison base is unavailable', () => {
    render(baseProps(null, {}, {
      currentSession: 'CLOSED',
      extendedQuote: {
        session: 'after-hours',
        price: 70.75,
        asOf: '2026-07-23T20:05:45.000Z',
        tradingDate: '2026-07-23',
        freshness: { status: 'cached', asOf: '2026-07-23T20:05:45.000Z', maxAgeSeconds: null },
        provider: 'polygon',
      },
    }));
    const row = container.querySelector('[data-testid="extended-hours-row"]');
    expect(row?.textContent).toContain('70.75');
    expect(row?.textContent).toContain('ข้อมูลที่บันทึกไว้');
  });

  it('keeps the extended row through reconnect and an unrelated React rerender', () => {
    const extendedQuote: SnapshotExtendedInput = {
      session: 'after-hours',
      price: 70.75,
      asOf: '2026-07-23T20:05:45.000Z',
      tradingDate: '2026-07-23',
      freshness: { status: 'stale', asOf: '2026-07-23T20:05:45.000Z', maxAgeSeconds: null },
      provider: 'polygon',
    };
    render(baseProps(BASE_QUOTE, { connectionState: 'reconnecting' }, {
      currentSession: 'CLOSED', extendedQuote,
    }));
    expect(container.querySelector('[data-testid="extended-hours-row"]')?.textContent).toContain('70.75');

    render(baseProps(BASE_QUOTE, { connectionState: 'connected', quoteLoading: true }, {
      currentSession: 'CLOSED', extendedQuote,
    }));
    expect(container.querySelector('[data-testid="extended-hours-row"]')?.textContent).toContain('70.75');
  });

  it('cleanly hides the secondary row when closed without an extended quote', () => {
    render(baseProps(BASE_QUOTE, {}, { currentSession: 'CLOSED' }));
    expect(container.textContent).toContain('ปิดตลาด');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
  });

  /**
   * Invariant B at the UI boundary: the production screenshot showed "ตลาดเปิด"
   * above a "หลังเวลาทำการ" row. Even when a caller hands the model an extended
   * print during REGULAR, the row must not render.
   */
  it('B: never renders an extended row while the market is REGULAR', () => {
    render(baseProps(BASE_QUOTE, {}, {
      currentSession: 'REGULAR',
      extendedQuote: {
        session: 'after-hours',
        price: 70.75,
        asOf: '2026-07-23T20:05:45.000Z',
        tradingDate: '2026-07-23',
        freshness: FRESHNESS,
        provider: 'polygon',
      },
    }));
    expect(container.textContent).toContain('ตลาดเปิด');
    expect(container.querySelector('[data-testid="extended-hours-row"]')).toBeNull();
    expect(container.textContent).not.toContain('หลังปิดตลาด');
  });

  it('F: a connected socket on a closed market still reads ปิดตลาด', () => {
    render(baseProps(BASE_QUOTE, { connectionState: 'awaiting-data' }, { currentSession: 'CLOSED' }));
    expect(container.textContent).toContain('เชื่อมต่อแล้ว · รอข้อมูลสด');
    expect(container.textContent).toContain('ปิดตลาด');
    expect(container.querySelector('[data-testid="current-session-label"]')?.textContent)
      .not.toContain('ตลาดเปิด');
  });

  it('labels a non-regular price date as data provenance, never as a live session', () => {
    render(baseProps(BASE_QUOTE, {}, { currentSession: 'CLOSED' }));
    const line = container.querySelector('[data-testid="session-line"]');
    // 2026-07-23 14:30Z = 10:30 ET on the 23rd.
    expect(line?.textContent).toContain('ข้อมูลล่าสุด 23/07');
  });
});
