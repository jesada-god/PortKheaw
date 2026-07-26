import { describe, expect, it } from 'vitest';
import { extendedQuoteMatchesRegularSession, selectExtendedHoursQuote } from './extended-hours';

/**
 * Windows below mirror a real Yahoo `currentTradingPeriod` for a US equity on
 * Friday 2026-07-24 (EDT, UTC-4):
 *   pre     04:00–09:30 ET → 08:00Z–13:30Z
 *   regular 09:30–16:00 ET → 13:30Z–20:00Z
 *   post    16:00–20:00 ET → 20:00Z–00:00Z(+1)
 */
const FRIDAY_PRE = { start: Date.UTC(2026, 6, 24, 8, 0) / 1_000, end: Date.UTC(2026, 6, 24, 13, 30) / 1_000 };
const FRIDAY_POST = { start: Date.UTC(2026, 6, 24, 20, 0) / 1_000, end: Date.UTC(2026, 6, 25, 0, 0) / 1_000 };
const FRIDAY_CLOSE_SECONDS = Date.UTC(2026, 6, 24, 20, 0) / 1_000;

/** Monday 2026-07-27 pre-market window. */
const MONDAY_PRE = { start: Date.UTC(2026, 6, 27, 8, 0) / 1_000, end: Date.UTC(2026, 6, 27, 13, 30) / 1_000 };
const MONDAY_POST = { start: Date.UTC(2026, 6, 27, 20, 0) / 1_000, end: Date.UTC(2026, 6, 28, 0, 0) / 1_000 };

const seconds = (...args: [number, number, number, number, number]) => Date.UTC(...args) / 1_000;

describe('selectExtendedHoursQuote', () => {
  it('returns the latest after-hours print during the after-hours session', () => {
    const result = selectExtendedHoursQuote({
      buckets: [
        [seconds(2026, 6, 24, 20, 5), 206.9],
        [seconds(2026, 6, 24, 21, 30), 206.75],
        [seconds(2026, 6, 24, 22, 15), 206.6],
      ],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result).not.toBeNull();
    expect(result!.session).toBe('after-hours');
    expect(result!.price).toBe(206.6);
    expect(result!.tradingDate).toBe('2026-07-24');
    expect(result!.asOf).toBe('2026-07-24T22:15:00.000Z');
    // Extended prints are never claimed as live.
    expect(result!.freshness.status).toBe('delayed');
  });

  it('returns the latest pre-market print before the open', () => {
    const result = selectExtendedHoursQuote({
      buckets: [
        [seconds(2026, 6, 27, 9, 0), 207.4],
        [seconds(2026, 6, 27, 12, 45), 208.1],
      ],
      preWindow: MONDAY_PRE,
      postWindow: MONDAY_POST,
      // Monday pre-market: the newest regular price is still Friday's close.
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result).not.toBeNull();
    expect(result!.session).toBe('premarket');
    expect(result!.price).toBe(208.1);
    expect(result!.tradingDate).toBe('2026-07-27');
  });

  it("shows Friday's after-hours print when read on a Sunday", () => {
    // Yahoo keeps reporting Friday's periods over the weekend; the regular price
    // beside it is also Friday's close, so this row is truthful and dated.
    const result = selectExtendedHoursQuote({
      buckets: [
        [seconds(2026, 6, 24, 12, 0), 209.5], // Friday pre-market
        [seconds(2026, 6, 24, 23, 55), 206.6], // Friday after-hours
      ],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result!.session).toBe('after-hours');
    expect(result!.price).toBe(206.6);
    expect(result!.tradingDate).toBe('2026-07-24');
  });

  it("never resurfaces a completed session's own pre-market print", () => {
    // The regular session already traded (its close is newer than the pre
    // window), so Friday's 04:00-09:30 prints are historical, not "ก่อนตลาดเปิด".
    const result = selectExtendedHoursQuote({
      buckets: [[seconds(2026, 6, 24, 12, 0), 209.5]],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result).toBeNull();
  });

  it('lets a newer pre-market print supersede the previous after-hours print', () => {
    const result = selectExtendedHoursQuote({
      buckets: [
        [seconds(2026, 6, 24, 23, 55), 206.6], // Friday after-hours
        [seconds(2026, 6, 27, 12, 45), 208.1], // Monday pre-market
      ],
      preWindow: MONDAY_PRE,
      postWindow: MONDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result!.session).toBe('premarket');
    expect(result!.price).toBe(208.1);
    expect(result!.tradingDate).toBe('2026-07-27');
  });

  it('accepts after-hours prints when the closing auction settles past the declared close', () => {
    // Observed live on AAPL: `regularMarketTime` is 20:00:01Z while the declared
    // post window starts at 20:00:00Z. Comparing against the window boundary
    // rather than the print's own timestamp silently dropped the whole row.
    const result = selectExtendedHoursQuote({
      buckets: [[seconds(2026, 6, 24, 23, 55), 333.8]],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS + 1,
      provider: 'yahoo-finance-chart',
    });

    expect(result).not.toBeNull();
    expect(result!.session).toBe('after-hours');
    expect(result!.price).toBe(333.8);
  });

  it('rejects buckets that fall outside the provider-declared windows', () => {
    const result = selectExtendedHoursQuote({
      // A regular-session bucket: inside neither extended window.
      buckets: [[seconds(2026, 6, 24, 17, 0), 205.1]],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result).toBeNull();
  });

  it('returns null during the regular session, when there is no extended print yet', () => {
    const midSession = seconds(2026, 6, 24, 17, 0);
    const result = selectExtendedHoursQuote({
      buckets: [[seconds(2026, 6, 24, 16, 55), 205.4]],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: midSession,
      provider: 'yahoo-finance-chart',
    });

    expect(result).toBeNull();
  });

  it('ignores null, non-finite and non-positive closes', () => {
    const result = selectExtendedHoursQuote({
      buckets: [
        [seconds(2026, 6, 24, 20, 5), 206.9],
        [seconds(2026, 6, 24, 21, 0), null],
        [seconds(2026, 6, 24, 22, 0), 0],
        [seconds(2026, 6, 24, 23, 0), Number.NaN],
      ],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    });

    expect(result!.price).toBe(206.9);
  });

  it('returns null without provider-declared windows', () => {
    expect(selectExtendedHoursQuote({
      buckets: [[seconds(2026, 6, 24, 22, 0), 206.6]],
      preWindow: null,
      postWindow: null,
      regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
      provider: 'yahoo-finance-chart',
    })).toBeNull();
  });

  it('returns null without a usable regular-session timestamp', () => {
    expect(selectExtendedHoursQuote({
      buckets: [[seconds(2026, 6, 24, 22, 0), 206.6]],
      preWindow: FRIDAY_PRE,
      postWindow: FRIDAY_POST,
      regularMarketTimeSeconds: 0,
      provider: 'yahoo-finance-chart',
    })).toBeNull();
  });
});

describe('extendedQuoteMatchesRegularSession', () => {
  const fridayAfterHours = selectExtendedHoursQuote({
    buckets: [[seconds(2026, 6, 24, 22, 15), 206.6]],
    preWindow: FRIDAY_PRE,
    postWindow: FRIDAY_POST,
    regularMarketTimeSeconds: FRIDAY_CLOSE_SECONDS,
    provider: 'yahoo-finance-chart',
  });

  it('accepts a print from the same trading date as the regular price', () => {
    expect(extendedQuoteMatchesRegularSession(fridayAfterHours, '2026-07-24T20:00:00.000Z')).toBe(true);
  });

  it('rejects a print from an older session than the regular price', () => {
    expect(extendedQuoteMatchesRegularSession(fridayAfterHours, '2026-07-27T20:00:00.000Z')).toBe(false);
  });

  it('rejects when either side is missing', () => {
    expect(extendedQuoteMatchesRegularSession(null, '2026-07-24T20:00:00.000Z')).toBe(false);
    expect(extendedQuoteMatchesRegularSession(fridayAfterHours, null)).toBe(false);
  });
});
