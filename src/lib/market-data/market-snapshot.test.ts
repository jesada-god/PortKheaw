import { describe, expect, it } from 'vitest';
import { resolveCurrentMarketSession, sessionPhaseOf, type CurrentMarketSession } from './current-session';
import {
  resolveCanonicalMarketSnapshot,
  type CanonicalMarketSnapshot,
  type SnapshotExtendedInput,
  type SnapshotQuoteInput,
} from './market-snapshot';
import type { Quote } from './types';

/**
 * The canonical market price snapshot — the resolver every price rule lives in.
 *
 * The suite is organised around the production defect it exists to close. On
 * 2026-07-29, NVTS's official regular close was **9.735**, and the header showed
 * **10.42** — an after-hours print that arrived later and therefore won on
 * freshness. The first test is that exact case with those exact numbers, and the
 * rest cover every session, closure kind and rejection path around it.
 *
 * All times are stated in ET so a fixture can be read against the exchange clock.
 * 2026-07-29 is a Wednesday; 2026-07-24 a Friday; 2026-07-26 a Sunday.
 */

const SYMBOL = 'NVTS';

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: SYMBOL,
    currency: 'USD',
    price: 9.735,
    open: 10.2,
    high: 11.04,
    low: 9.72,
    previousClose: 10.01,
    previousRegularClose: 10.01,
    regularClose: 9.735,
    change: -0.275,
    changePercent: -2.7472,
    volume: 21_587_852,
    latestTradingDay: '2026-07-29',
    quoteTimestamp: '2026-07-29T20:00:01.000Z',
    priceSource: 'yahoo-finance-chart.regularMarketPrice',
    previousCloseSource: 'yahoo-chart.previous-completed-daily-candle',
    ...overrides,
  };
}

function resource(data: Quote | null, asOf: string | null, extras: Partial<SnapshotQuoteInput> = {}): SnapshotQuoteInput {
  return {
    data,
    freshness: { status: 'delayed', asOf, maxAgeSeconds: 60 },
    provider: 'yahoo-finance-chart',
    ...extras,
  };
}

function resolve(input: {
  session: CurrentMarketSession;
  now: string;
  exchangeDate?: string;
  closeReason?: CanonicalMarketSnapshot['closeReason'];
  quote?: SnapshotQuoteInput | null;
  initialQuote?: SnapshotQuoteInput | null;
  extended?: SnapshotExtendedInput | null;
}): CanonicalMarketSnapshot {
  const phase = sessionPhaseOf(input.session);
  return resolveCanonicalMarketSnapshot({
    symbol: SYMBOL,
    session: {
      session: input.session,
      phase,
      closeReason: input.closeReason ?? (phase === 'CLOSED' ? 'NORMAL' : null),
      evaluatedAt: input.now,
      source: 'exchange-calendar',
      exchangeDate: input.exchangeDate ?? input.now.slice(0, 10),
      provider: { accepted: false, status: null, asOf: null, source: null, rejection: 'missing' },
    },
    quote: input.quote ?? resource(quote(), '2026-07-29T20:00:01.000Z'),
    initialQuote: input.initialQuote ?? null,
    extended: input.extended ?? null,
    now: input.now,
  });
}

/* ------------------------------- 1. CLOSED -------------------------------- */

describe('1. CLOSED — the main line is the official regular close, never a stale value', () => {
  /** 21:30 ET on Wednesday 2026-07-29: past the after-hours window. */
  const CLOSED_NOW = '2026-07-30T01:30:00.000Z';

  it('shows 9.735 (official close) and not 10.42 (the stale after-hours print)', () => {
    // The exact production shape: the accepted pipeline's `price` is a 16:41 ET
    // after-hours trade, while the quote's own `regularClose` is the real close.
    const snapshot = resolve({
      session: 'CLOSED',
      now: CLOSED_NOW,
      exchangeDate: '2026-07-29',
      quote: resource(
        quote({ price: 10.42, quoteTimestamp: '2026-07-29T20:41:12.000Z' }),
        '2026-07-29T20:41:12.000Z',
      ),
    });

    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.mainPriceSource).toBe('yahoo-finance-chart.regularClose');
    expect(snapshot.regularClose).toBe(9.735);
    expect(snapshot.previousRegularClose).toBe(10.01);
    // The refusal is recorded, not silent.
    expect(snapshot.flags).toContain('extended-overwrite-rejected');
  });

  it('measures the daily change against the previous regular close', () => {
    const snapshot = resolve({ session: 'CLOSED', now: CLOSED_NOW, exchangeDate: '2026-07-29' });
    expect(snapshot.comparisonBase).toBe(10.01);
    expect(snapshot.comparisonBaseKind).toBe('previous-regular-close');
  });

  it('never lets a live WebSocket tick from the same evening reach the main line', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: CLOSED_NOW,
      exchangeDate: '2026-07-29',
      quote: {
        // A realtime-labelled stream value: the shape that used to win on freshness.
        data: quote({ price: 9.589, quoteTimestamp: '2026-07-29T23:58:00.000Z' }),
        freshness: { status: 'realtime', asOf: '2026-07-29T23:58:00.000Z', maxAgeSeconds: 15 },
        provider: 'alpaca:iex',
      },
    });
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
  });

  it('never promotes previousRegularClose into regularClose when the close is missing', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: CLOSED_NOW,
      exchangeDate: '2026-07-29',
      quote: resource(
        // Yesterday's close is present; today's is not. Showing 10.01 as "today's
        // close" would also compute a change of exactly zero against itself.
        quote({ regularClose: null, price: 10.42, quoteTimestamp: '2026-07-29T20:41:12.000Z' }),
        '2026-07-29T20:41:12.000Z',
      ),
    });
    expect(snapshot.regularClose).toBeNull();
    expect(snapshot.mainPrice).toBeNull();
    expect(snapshot.flags).toContain('regular-close-unavailable');
  });

  it('reports a finalized close without a staleness flag, however late the evening', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-07-30T05:00:00.000Z', // 01:00 ET, nine hours after the bell
      exchangeDate: '2026-07-29',
    });
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.flags).not.toContain('stale-main-price');
  });
});

/* -------------------------------- 2. POST --------------------------------- */

describe('2. POST — the close is the main line and the post-market print is the second row', () => {
  /** 16:30 ET on Wednesday 2026-07-29. */
  const POST_NOW = '2026-07-29T20:30:00.000Z';
  const postPrint: SnapshotExtendedInput = {
    session: 'after-hours',
    price: 9.589,
    asOf: '2026-07-29T20:25:00.000Z',
    tradingDate: '2026-07-29',
    provider: 'yahoo-finance-chart',
    freshness: { status: 'delayed', asOf: '2026-07-29T20:25:00.000Z', maxAgeSeconds: 900 },
  };

  it('keeps the official close on the main line and the print in the second row', () => {
    const snapshot = resolve({ session: 'AFTER_HOURS', now: POST_NOW, extended: postPrint });
    expect(snapshot.session).toBe('POST');
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.extendedPrice).toBe(9.589);
    expect(snapshot.extendedSession).toBe('after-hours');
    expect(snapshot.extendedPriceSource).toBe('yahoo-finance-chart.postMarketPrice');
  });

  it('leaves regularClose available as the second row comparison base', () => {
    const snapshot = resolve({ session: 'AFTER_HOURS', now: POST_NOW, extended: postPrint });
    // 9.589 - 9.735 = -0.146, which is what the header projects onto the row.
    expect(snapshot.regularClose).toBe(9.735);
    expect(snapshot.comparisonBase).toBe(10.01);
  });

  it('refuses a post-market print that is not newer than the close it follows', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: POST_NOW,
      // 15:30 ET: inside the regular session, so it cannot be a post-market print.
      extended: { ...postPrint, asOf: '2026-07-29T19:30:00.000Z' },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('session-mismatch');
  });

  it('refuses a pre-market print offered during POST', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: POST_NOW,
      extended: { ...postPrint, session: 'premarket' },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('session-mismatch');
  });
});

/* --------------------------------- 3. PRE --------------------------------- */

describe('3. PRE — the pre-market print IS the main line', () => {
  /** 08:30 ET on Thursday 2026-07-30. */
  const PRE_NOW = '2026-07-30T12:30:00.000Z';
  const prePrint: SnapshotExtendedInput = {
    session: 'premarket',
    price: 10.15,
    asOf: '2026-07-30T12:25:00.000Z',
    tradingDate: '2026-07-30',
    provider: 'yahoo-finance-chart',
    freshness: { status: 'delayed', asOf: '2026-07-30T12:25:00.000Z', maxAgeSeconds: 900 },
  };

  it('puts the latest pre-market print on the main line, compared to the previous close', () => {
    const snapshot = resolve({
      session: 'PREMARKET',
      now: PRE_NOW,
      exchangeDate: '2026-07-30',
      extended: prePrint,
    });
    expect(snapshot.session).toBe('PRE');
    expect(snapshot.mainPrice).toBe(10.15);
    expect(snapshot.mainPriceRole).toBe('premarket');
    // 2026-07-29's close is the previous regular close for a 07-30 pre-market print.
    expect(snapshot.comparisonBase).toBe(10.01);
    expect(snapshot.comparisonBaseKind).toBe('previous-regular-close');
  });

  it('does not duplicate the print into a secondary row', () => {
    const snapshot = resolve({
      session: 'PREMARKET', now: PRE_NOW, exchangeDate: '2026-07-30', extended: prePrint,
    });
    expect(snapshot.extendedPrice).toBeNull();
  });

  it('falls back to the latest completed close only when there is no pre-market print', () => {
    const snapshot = resolve({ session: 'PREMARKET', now: PRE_NOW, exchangeDate: '2026-07-30' });
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.flags).toContain('extended-unavailable');
  });
});

/* ------------------------------- 4. REGULAR ------------------------------- */

describe('4. REGULAR — the main line is the live regular price', () => {
  /** 11:00 ET on Wednesday 2026-07-29. */
  const REGULAR_NOW = '2026-07-29T15:00:00.000Z';

  it('shows the live regular price against the previous regular close', () => {
    const snapshot = resolve({
      session: 'REGULAR',
      now: REGULAR_NOW,
      quote: resource(
        quote({ price: 10.42, regularClose: 10.42, quoteTimestamp: '2026-07-29T14:59:30.000Z' }),
        '2026-07-29T14:59:30.000Z',
      ),
    });
    expect(snapshot.mainPrice).toBe(10.42);
    expect(snapshot.mainPriceRole).toBe('regular');
    expect(snapshot.comparisonBase).toBe(10.01);
    expect(snapshot.comparisonBaseKind).toBe('previous-regular-close');
  });

  it('never renders an extended row during the regular session', () => {
    const snapshot = resolve({
      session: 'REGULAR',
      now: REGULAR_NOW,
      quote: resource(
        quote({ price: 10.42, regularClose: 10.42, quoteTimestamp: '2026-07-29T14:59:30.000Z' }),
        '2026-07-29T14:59:30.000Z',
      ),
      extended: {
        session: 'after-hours', price: 9.589, asOf: '2026-07-28T20:25:00.000Z',
        tradingDate: '2026-07-28', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-28T20:25:00.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('extended-print-rejected');
  });

  it('falls back to the close, never to an extended print, when no live regular price exists', () => {
    const snapshot = resolve({
      session: 'REGULAR',
      now: REGULAR_NOW,
      // The pipeline is still serving last night's after-hours print.
      quote: resource(
        quote({ price: 9.589, quoteTimestamp: '2026-07-28T23:50:00.000Z' }),
        '2026-07-28T23:50:00.000Z',
      ),
    });
    expect(snapshot.mainPrice).not.toBe(9.589);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.flags).toContain('session-mismatch');
  });

  it('flags a live regular price that has stopped advancing', () => {
    const snapshot = resolve({
      session: 'REGULAR',
      now: REGULAR_NOW,
      quote: resource(
        // 10:00 ET, an hour before `now`.
        quote({ price: 10.42, regularClose: 10.42, quoteTimestamp: '2026-07-29T14:00:00.000Z' }),
        '2026-07-29T14:00:00.000Z',
      ),
    });
    expect(snapshot.mainPriceRole).toBe('regular');
    expect(snapshot.flags).toContain('stale-main-price');
  });
});

/* ------------------------- 5-7. closure kinds ----------------------------- */

describe('5. holiday closure', () => {
  it('is CLOSED with a HOLIDAY reason and still shows the latest completed close', () => {
    // Independence Day 2026 is observed Friday 2026-07-03.
    const resolved = resolveCurrentMarketSession({ now: '2026-07-03T17:00:00.000Z' });
    expect(resolved.session).toBe('HOLIDAY');
    expect(resolved.phase).toBe('CLOSED');
    expect(resolved.closeReason).toBe('HOLIDAY');

    const snapshot = resolve({
      session: 'HOLIDAY',
      now: '2026-07-03T17:00:00.000Z',
      exchangeDate: '2026-07-03',
      closeReason: 'HOLIDAY',
      quote: resource(
        quote({ latestTradingDay: '2026-07-02', quoteTimestamp: '2026-07-02T20:00:01.000Z' }),
        '2026-07-02T20:00:01.000Z',
      ),
    });
    expect(snapshot.session).toBe('CLOSED');
    expect(snapshot.closeReason).toBe('HOLIDAY');
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.tradingDate).toBe('2026-07-02');
  });

  it('reports EVENT for an unscheduled closure on an ordinary trading day', () => {
    const resolved = resolveCurrentMarketSession({
      now: '2026-07-29T17:00:00.000Z',
      // A verified closure the published calendar does not list.
      holidays: new Set(['2026-07-29']),
    });
    expect(resolved.session).toBe('HOLIDAY');
    // The calendar-supplied set makes it a known closure, so it reads as a holiday.
    expect(resolved.closeReason).toBe('HOLIDAY');

    // A closure asserted with no calendar entry at all is the EVENT case.
    const unscheduled = resolveCurrentMarketSession({
      now: '2026-07-29T17:00:00.000Z',
      marketStatus: {
        status: 'holiday', asOf: '2026-07-29T17:00:00.000Z',
        source: 'polygon-market-status', stale: false, maxAgeSeconds: 30,
      },
    });
    expect(unscheduled.session).toBe('HOLIDAY');
    expect(unscheduled.closeReason).toBe('EVENT');
  });

  it('steps the canonical date back to the previous session on an EVENT closure', () => {
    const snapshot = resolve({
      session: 'HOLIDAY',
      now: '2026-07-29T17:00:00.000Z',
      exchangeDate: '2026-07-29',
      closeReason: 'EVENT',
      quote: resource(
        quote({ latestTradingDay: '2026-07-28', quoteTimestamp: '2026-07-28T20:00:01.000Z' }),
        '2026-07-28T20:00:01.000Z',
      ),
    });
    expect(snapshot.closeReason).toBe('EVENT');
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.tradingDate).toBe('2026-07-28');
  });
});

describe('6. weekend closure', () => {
  it('is CLOSED with a WEEKEND reason and shows Friday close', () => {
    // Sunday 2026-07-26, 13:00 ET.
    const resolved = resolveCurrentMarketSession({ now: '2026-07-26T17:00:00.000Z' });
    expect(resolved.session).toBe('CLOSED');
    expect(resolved.closeReason).toBe('WEEKEND');

    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-07-26T17:00:00.000Z',
      exchangeDate: '2026-07-26',
      closeReason: 'WEEKEND',
      quote: resource(
        quote({ latestTradingDay: '2026-07-24', quoteTimestamp: '2026-07-24T20:00:01.000Z' }),
        '2026-07-24T20:00:01.000Z',
      ),
    });
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.tradingDate).toBe('2026-07-24');
  });

  it("still shows Friday's after-hours print in the second row on a Sunday", () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-07-26T17:00:00.000Z',
      exchangeDate: '2026-07-26',
      closeReason: 'WEEKEND',
      quote: resource(
        quote({ latestTradingDay: '2026-07-24', quoteTimestamp: '2026-07-24T20:00:01.000Z' }),
        '2026-07-24T20:00:01.000Z',
      ),
      extended: {
        session: 'after-hours', price: 9.65, asOf: '2026-07-24T23:55:00.000Z',
        tradingDate: '2026-07-24', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-24T23:55:00.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.extendedPrice).toBe(9.65);
    expect(snapshot.extendedPriceTradingDate).toBe('2026-07-24');
    // …and it never becomes the main line.
    expect(snapshot.mainPrice).toBe(9.735);
  });
});

describe('7. early close', () => {
  /** 2026-11-27 is the Friday after Thanksgiving: a published 13:00 ET half-day. */
  it('ends the regular session at 13:00 ET and opens after-hours there', () => {
    // 13:30 ET — after a half-day close, so the POST window has begun.
    const post = resolveCurrentMarketSession({ now: '2026-11-27T18:30:00.000Z' });
    expect(post.session).toBe('AFTER_HOURS');
    expect(post.phase).toBe('POST');
    expect(post.closeReason).toBeNull();

    // 12:30 ET — still inside the shortened regular session.
    const regular = resolveCurrentMarketSession({ now: '2026-11-27T17:30:00.000Z' });
    expect(regular.session).toBe('REGULAR');
  });

  it('reports EARLY_CLOSE once the half-day is over, and not before it opens', () => {
    // 17:30 ET — past the shifted after-hours window (13:00 + 4h = 17:00).
    const after = resolveCurrentMarketSession({ now: '2026-11-27T22:30:00.000Z' });
    expect(after.session).toBe('CLOSED');
    expect(after.closeReason).toBe('EARLY_CLOSE');

    // 03:00 ET on the same half-day: the session has not opened, let alone closed
    // early, so calling it an early close would be wrong.
    const beforeOpen = resolveCurrentMarketSession({ now: '2026-11-27T08:00:00.000Z' });
    expect(beforeOpen.session).toBe('CLOSED');
    expect(beforeOpen.closeReason).toBe('NORMAL');
  });

  it("takes that day's own 13:00 close as the main line", () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-11-27T22:30:00.000Z',
      exchangeDate: '2026-11-27',
      closeReason: 'EARLY_CLOSE',
      quote: resource(
        // The half-day close prints at 13:00 ET, which is 18:00Z.
        quote({
          price: 9.9, regularClose: 9.9,
          latestTradingDay: '2026-11-27', quoteTimestamp: '2026-11-27T18:00:00.000Z',
        }),
        '2026-11-27T18:00:00.000Z',
      ),
    });
    expect(snapshot.mainPrice).toBe(9.9);
    expect(snapshot.tradingDate).toBe('2026-11-27');
    expect(snapshot.closeReason).toBe('EARLY_CLOSE');
  });

  it('recognises a half-day close stamped exactly at 13:00 ET even without an explicit field', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-11-27T22:30:00.000Z',
      exchangeDate: '2026-11-27',
      closeReason: 'EARLY_CLOSE',
      quote: resource(
        quote({
          price: 9.9, regularClose: null,
          latestTradingDay: '2026-11-27', quoteTimestamp: '2026-11-27T18:00:00.000Z',
        }),
        '2026-11-27T18:00:00.000Z',
      ),
    });
    expect(snapshot.regularClose).toBe(9.9);
    expect(snapshot.mainPriceRole).toBe('regular-close');
  });
});

/* ---------------------- 8-10. validation and rejection -------------------- */

describe('8. no extended data', () => {
  it('produces no extended values at all, so no row and no fabricated 0.00%', () => {
    const snapshot = resolve({
      session: 'CLOSED', now: '2026-07-30T01:30:00.000Z', exchangeDate: '2026-07-29',
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.extendedSession).toBeNull();
    expect(snapshot.extendedPriceTimestamp).toBeNull();
    expect(snapshot.extendedPriceSource).toBeNull();
    expect(snapshot.flags).toContain('extended-unavailable');
  });

  it('never dresses the regular close up as an extended print', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: '2026-07-29T20:30:00.000Z',
      // The close itself, offered as an after-hours print. Accepting it would show
      // 9.735 twice and compute a 0.00% "extended change" of the close on itself.
      extended: {
        session: 'after-hours', price: 9.735, asOf: '2026-07-29T20:00:01.000Z',
        tradingDate: '2026-07-29', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-29T20:00:01.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('session-mismatch');
  });

  it('rejects a non-positive extended price', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: '2026-07-29T20:30:00.000Z',
      extended: {
        session: 'after-hours', price: 0, asOf: '2026-07-29T20:25:00.000Z',
        tradingDate: '2026-07-29', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-29T20:25:00.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('extended-print-rejected');
  });
});

describe('9. timestamp and trading-date mismatch', () => {
  it('rejects a regular close from a different trading date than the session requires', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-07-30T01:30:00.000Z',
      exchangeDate: '2026-07-29',
      // A cached quote from two sessions ago.
      quote: resource(
        quote({ latestTradingDay: '2026-07-27', quoteTimestamp: '2026-07-27T20:00:01.000Z' }),
        '2026-07-27T20:00:01.000Z',
      ),
    });
    expect(snapshot.flags).toContain('trading-date-mismatch');
    expect(snapshot.mainPrice).toBeNull();
  });

  it('rejects an extended print stamped implausibly in the future', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: '2026-07-29T20:30:00.000Z',
      extended: {
        // 19:00 ET, half an hour of ET clock ahead of a 16:30 ET evaluation.
        session: 'after-hours', price: 9.5, asOf: '2026-07-29T23:00:00.000Z',
        tradingDate: '2026-07-29', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-29T23:00:00.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.extendedPrice).toBeNull();
    expect(snapshot.flags).toContain('future-timestamp-rejected');
  });

  it('rejects a live regular price stamped in the future', () => {
    const snapshot = resolve({
      session: 'REGULAR',
      now: '2026-07-29T15:00:00.000Z',
      quote: resource(
        quote({ price: 10.42, regularClose: null, quoteTimestamp: '2026-07-29T15:30:00.000Z' }),
        '2026-07-29T15:30:00.000Z',
      ),
    });
    expect(snapshot.flags).toContain('future-timestamp-rejected');
    expect(snapshot.mainPrice).not.toBe(10.42);
  });

  it('falls back to the server-verified quote when the live one is off-date', () => {
    const snapshot = resolve({
      session: 'CLOSED',
      now: '2026-07-30T01:30:00.000Z',
      exchangeDate: '2026-07-29',
      quote: resource(
        quote({ regularClose: 8.5, latestTradingDay: '2026-07-27', quoteTimestamp: '2026-07-27T20:00:01.000Z' }),
        '2026-07-27T20:00:01.000Z',
      ),
      initialQuote: resource(quote(), '2026-07-29T20:00:01.000Z'),
    });
    // The stale candidate is refused and the verified server close is used, with
    // its meaning preserved: still `regularClose`, never a last trade.
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceSource).toBe('yahoo-finance-chart.regularClose');
    expect(snapshot.flags).toContain('trading-date-mismatch');
  });
});

describe('10. stale reconnect and cache overwrite', () => {
  it('an older reconnect payload cannot replace the correct close', () => {
    const fresh = resolve({
      session: 'CLOSED', now: '2026-07-30T01:30:00.000Z', exchangeDate: '2026-07-29',
    });
    expect(fresh.mainPrice).toBe(9.735);

    // A reconnect replays an older cached quote with a DIFFERENT close.
    const afterReconnect = resolve({
      session: 'CLOSED',
      now: '2026-07-30T01:30:00.000Z',
      exchangeDate: '2026-07-29',
      quote: resource(
        quote({ regularClose: 10.01, latestTradingDay: '2026-07-28', quoteTimestamp: '2026-07-28T20:00:00.000Z' }),
        '2026-07-28T20:00:00.000Z',
      ),
      initialQuote: resource(quote(), '2026-07-29T20:00:01.000Z'),
    });
    expect(afterReconnect.mainPrice).toBe(9.735);
    expect(afterReconnect.regularCloseSource).toBe('yahoo-finance-chart.regularClose');
  });

  it('is a pure function of its inputs, so a rerender cannot drift', () => {
    const args = { session: 'CLOSED' as const, now: '2026-07-30T01:30:00.000Z', exchangeDate: '2026-07-29' };
    expect(resolve(args)).toEqual(resolve(args));
  });
});

/* --------------------------- 11. timezone safety -------------------------- */

describe('11. timezone — a Bangkok reader still gets ET decisions', () => {
  it('resolves the session from the instant in America/New_York, not a local zone', () => {
    // 2026-07-30 03:00 in Bangkok is 2026-07-29 16:00 ET: the market just closed,
    // so this is the after-hours window on the 29th — not "the 30th, pre-market".
    const resolved = resolveCurrentMarketSession({ now: '2026-07-29T20:00:00.000Z' });
    expect(resolved.session).toBe('AFTER_HOURS');
    expect(resolved.exchangeDate).toBe('2026-07-29');
  });

  it('dates the close by the exchange session, not the reader calendar day', () => {
    const snapshot = resolve({ session: 'AFTER_HOURS', now: '2026-07-29T20:30:00.000Z' });
    // 20:00:01Z is already the 30th in Bangkok; the trading date is still the 29th.
    expect(snapshot.tradingDate).toBe('2026-07-29');
  });

  it('keeps the close on the same trading date past midnight UTC', () => {
    // 21:00 ET on the 29th = 01:00Z on the 30th.
    const snapshot = resolve({
      session: 'CLOSED', now: '2026-07-30T01:00:00.000Z', exchangeDate: '2026-07-29',
    });
    expect(snapshot.tradingDate).toBe('2026-07-29');
    expect(snapshot.mainPrice).toBe(9.735);
  });
});

/* ----------------------- unresolved session safety ------------------------ */

describe('an unresolved session applies the CLOSED rules', () => {
  it('shows the latest completed close and never a live or extended value', () => {
    const snapshot = resolve({
      session: 'UNKNOWN',
      now: '2026-07-29T20:30:00.000Z',
      quote: resource(
        quote({ price: 10.42, quoteTimestamp: '2026-07-29T20:25:00.000Z' }),
        '2026-07-29T20:25:00.000Z',
      ),
    });
    expect(snapshot.session).toBe('CLOSED');
    expect(snapshot.mainPrice).toBe(9.735);
    expect(snapshot.mainPriceRole).toBe('regular-close');
    expect(snapshot.flags).toContain('session-unresolved');
  });
});

describe('every resolved value carries its source', () => {
  it('names the provider and field behind each price', () => {
    const snapshot = resolve({
      session: 'AFTER_HOURS',
      now: '2026-07-29T20:30:00.000Z',
      extended: {
        session: 'after-hours', price: 9.589, asOf: '2026-07-29T20:25:00.000Z',
        tradingDate: '2026-07-29', provider: 'yahoo-finance-chart',
        freshness: { status: 'delayed', asOf: '2026-07-29T20:25:00.000Z', maxAgeSeconds: 900 },
      },
    });
    expect(snapshot.regularCloseSource).toBe('yahoo-finance-chart.regularClose');
    expect(snapshot.previousRegularCloseSource).toBe('yahoo-chart.previous-completed-daily-candle');
    expect(snapshot.extendedPriceSource).toBe('yahoo-finance-chart.postMarketPrice');
    expect(snapshot.mainPriceProvider).toBe('yahoo-finance-chart');
    expect(snapshot.sessionSource).toBe('exchange-calendar');
  });

  it('separates the session evaluation instant from every price timestamp', () => {
    const snapshot = resolve({ session: 'AFTER_HOURS', now: '2026-07-29T20:30:00.000Z' });
    expect(snapshot.evaluatedAt).toBe('2026-07-29T20:30:00.000Z');
    expect(snapshot.regularCloseTimestamp).toBe('2026-07-29T20:00:01.000Z');
    expect(snapshot.evaluatedAt).not.toBe(snapshot.regularCloseTimestamp);
  });
});
