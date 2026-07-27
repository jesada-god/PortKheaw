import { describe, expect, it } from 'vitest';
import type { Quote } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import {
  calculatePriceChange,
  connectionStatusPresentation,
  convertUsdForDisplay,
  dataStatusPresentation,
  extendedSessionPresentation,
  priceDirectionPresentation,
  priceFlashDirection,
  preserveLastKnownExtendedQuote,
  resolvePriceChange,
  resolvePriceCurrency,
  resolveDataStatus,
  resolvePriceHeaderData,
  buildStockPriceHeaderModel,
  formatSessionDateLabel,
  priceSessionLabel,
  type PriceHeaderExtendedQuote,
} from './price-header';

describe('stock price header extended-row session labels', () => {
  it.each([
    ['premarket', '🌅', 'ก่อนตลาดเปิด'],
    // Not the 🌙 of "ตลาดปิด": both are on screen whenever a completed
    // after-hours row is shown while the market is closed.
    ['after-hours', '🌇', 'หลังเวลาทำการ'],
  ] as const)('maps %s to a stable emoji and Thai label', (session, emoji, label) => {
    expect(extendedSessionPresentation(session)).toEqual(expect.objectContaining({ emoji, label }));
  });
});

describe('stock price header data status mapping', () => {
  it.each([
    ['live', null, 'ราคาสด'],
    ['delayed', '⏱️', 'ราคาล่าช้า'],
    ['cached', '💾', 'ข้อมูลที่บันทึกไว้'],
    ['stale', '🕒', 'ข้อมูลอาจล่าช้า'],
    ['unavailable', '⚠️', 'ไม่มีข้อมูล'],
  ] as const)('maps %s independently from market session', (status, emoji, label) => {
    expect(dataStatusPresentation(status)).toEqual(expect.objectContaining({ emoji, label }));
  });

  it('does not label delayed or end-of-day data as realtime', () => {
    const base = { asOf: '2026-07-20T12:00:00.000Z', maxAgeSeconds: 300 };
    expect(resolveDataStatus({ ...base, status: 'delayed' }, Date.parse('2026-07-20T12:01:00.000Z'))).toBe('delayed');
    expect(resolveDataStatus({ ...base, status: 'end-of-day' }, Date.parse('2026-07-20T12:01:00.000Z'))).toBe('delayed');
  });

  it('marks data stale only from provider timestamp and threshold', () => {
    const freshness = { status: 'realtime' as const, asOf: '2026-07-20T12:00:00.000Z', maxAgeSeconds: 300 };
    expect(resolveDataStatus(freshness, Date.parse('2026-07-20T12:04:59.000Z'))).toBe('live');
    expect(resolveDataStatus(freshness, Date.parse('2026-07-20T12:05:01.000Z'))).toBe('stale');
  });
});

const HEADER_QUOTE: Quote = {
  symbol: 'RKLB',
  currency: 'USD',
  price: 100,
  open: 99,
  high: 102,
  low: 98,
  previousClose: 98,
  change: 2,
  changePercent: (2 / 98) * 100,
  volume: 1_000,
  latestTradingDay: null,
};

function quoteResource(
  quote: Quote,
  asOf: string,
  maxAgeSeconds = 900,
): StockDetailQuoteResource {
  return {
    data: quote,
    freshness: { status: 'realtime', asOf, maxAgeSeconds },
    provider: 'polygon',
    reason: null,
    error: null,
    fallbackLabel: null,
  };
}

describe('stock price header accepted quote partition', () => {
  it('keeps a regular-market accepted price in the main row', () => {
    const current = quoteResource(HEADER_QUOTE, '2026-07-20T14:00:00.000Z');
    const result = resolvePriceHeaderData({
      current,
      initial: current,
      currentSession: 'REGULAR',
      evaluatedAt: '2026-07-20T14:00:10.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toBeNull();
  });

  it('uses the accepted pre-market price only in the secondary row and compares from the real regular close', () => {
    const current = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      '2026-07-20T12:30:00.000Z',
    );
    const result = resolvePriceHeaderData({
      current,
      initial: current,
      currentSession: 'PREMARKET',
      evaluatedAt: '2026-07-20T12:30:10.000Z',
    });
    expect(result.quote?.price).toBe(100);
    expect(result.quote?.change).toBe(0);
    expect(result.extendedQuote).toMatchObject({ session: 'premarket', price: 101 });
  });

  it('keeps the last accepted regular quote primary during after-hours', () => {
    const initial = quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z');
    const current = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      '2026-07-20T21:00:00.000Z',
    );
    const result = resolvePriceHeaderData({
      current,
      initial,
      currentSession: 'AFTER_HOURS',
      evaluatedAt: '2026-07-20T21:00:10.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toMatchObject({ session: 'after-hours', price: 101 });
  });

  it('keeps a real-time extended trade separate from the regular close after hours', () => {
    const initial = quoteResource(HEADER_QUOTE, '2026-07-23T20:00:00.000Z');
    const current = {
      ...quoteResource(
        { ...HEADER_QUOTE, price: 206.87, previousClose: 208.76 },
        '2026-07-24T20:26:14.801Z',
      ),
      provider: 'alpaca:iex',
    };
    const result = resolvePriceHeaderData({
      current,
      initial,
      currentSession: 'AFTER_HOURS',
      evaluatedAt: '2026-07-24T20:26:15.000Z',
    });
    expect(result.quote?.price).toBe(208.76);
    expect(result.provider).toBe('alpaca:iex');
    expect(result.fallbackLabel).toBeNull();
    expect(result.extendedQuote).toMatchObject({ session: 'after-hours', price: 206.87 });
  });

  it('uses the explicit latest regular close instead of the older previous close after hours', () => {
    const initial = quoteResource({
      ...HEADER_QUOTE,
      price: 206.87,
      regularClose: 206.87,
      previousClose: 208.76,
      previousRegularClose: 208.76,
    }, '2026-07-24T20:00:00.000Z');
    const current = quoteResource({ ...initial.data!, price: 207.42 }, '2026-07-24T23:58:31.000Z');
    const result = resolvePriceHeaderData({
      current,
      initial,
      currentSession: 'AFTER_HOURS',
      evaluatedAt: '2026-07-24T23:58:32.000Z',
    });
    expect(result.quote?.price).toBe(206.87);
    expect(result.quote?.previousRegularClose).toBe(208.76);
    expect(result.extendedQuote?.price).toBe(207.42);
  });

  it('shows a closed regular quote without an extended row when no extended quote was accepted', () => {
    const current = quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z');
    const result = resolvePriceHeaderData({
      current,
      initial: current,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-20T20:00:10.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toBeNull();
  });

  it('keeps a stale extended quote in the secondary row without promoting it to current', () => {
    const initial = quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z');
    const current = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      '2026-07-20T21:00:00.000Z',
      60,
    );
    const result = resolvePriceHeaderData({
      current,
      initial,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-20T21:02:00.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote?.price).toBe(101);
    expect(resolveDataStatus(result.extendedQuote!.freshness, Date.parse('2026-07-20T21:02:00.000Z'))).toBe('stale');
  });
});

describe('last-known extended quote persistence', () => {
  const afterHours: PriceHeaderExtendedQuote = {
    session: 'after-hours',
    price: 101.25,
    asOf: '2026-07-20T23:55:00.000Z',
    tradingDate: '2026-07-20',
    freshness: { status: 'realtime', asOf: '2026-07-20T23:55:00.000Z', maxAgeSeconds: 60 },
    provider: 'polygon',
  };

  it('does not clear the quote when a regular snapshot or canonical sync omits extended fields', () => {
    const accepted = preserveLastKnownExtendedQuote(null, afterHours);
    expect(preserveLastKnownExtendedQuote(accepted, null)).toBe(accepted);
    expect(preserveLastKnownExtendedQuote(accepted, undefined)).toBe(accepted);
  });

  it('does not let an older reconnect snapshot overwrite the newer quote', () => {
    const older = {
      ...afterHours,
      price: 100.5,
      asOf: '2026-07-20T23:45:00.000Z',
      freshness: { ...afterHours.freshness, asOf: '2026-07-20T23:45:00.000Z' },
    };
    expect(preserveLastKnownExtendedQuote(afterHours, older)).toBe(afterHours);
  });

  it('allows freshness to downgrade for the same real print without losing provenance', () => {
    const cached = {
      ...afterHours,
      freshness: { ...afterHours.freshness, status: 'cached' as const },
    };
    expect(preserveLastKnownExtendedQuote(afterHours, cached)).toBe(cached);
  });

  it('reuses the persisted quote after a regular snapshot replaces the canonical price', () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-20T23:59:00.000Z',
      serverExtendedQuote: preserveLastKnownExtendedQuote(null, afterHours),
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toEqual(afterHours);
  });

  it('does not let a later regular-close snapshot overwrite the persisted extended price', () => {
    const regularSnapshot = quoteResource(
      { ...HEADER_QUOTE, price: 100, regularClose: 100 },
      '2026-07-20T23:58:00.000Z',
    );
    const result = resolvePriceHeaderData({
      current: regularSnapshot,
      initial: quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z'),
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-20T23:59:00.000Z',
      serverExtendedQuote: afterHours,
    });
    expect(result.quote?.price).toBe(100);
    expect(result.extendedQuote).toBe(afterHours);
  });

  /**
   * A pre-market print belongs to the session that has NOT traded yet, so it is
   * always dated after the completed regular close beside it. It must survive the
   * current session flipping to CLOSED — the row is dropped only by a newer real
   * price, never by the clock.
   */
  it('preserves pre-market provenance after the session becomes closed', () => {
    const premarket: PriceHeaderExtendedQuote = {
      ...afterHours,
      session: 'premarket',
      price: 99.5,
      asOf: '2026-07-27T12:45:00.000Z',
      tradingDate: '2026-07-27',
      freshness: { status: 'cached', asOf: '2026-07-27T12:45:00.000Z', maxAgeSeconds: null },
    };
    // Friday's close is still the primary row; Monday has not opened.
    const regular = quoteResource(HEADER_QUOTE, '2026-07-24T19:59:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-27T13:10:00.000Z',
      serverExtendedQuote: premarket,
    });
    expect(result.extendedQuote?.session).toBe('premarket');
    expect(result.extendedQuote?.price).toBe(99.5);
  });

  /**
   * The other half of the same policy: once the regular session has traded PAST a
   * pre-market print, the primary row carries the newer price and the morning's
   * print is history, not "ก่อนตลาดเปิด".
   */
  it('drops a pre-market print the regular session has already traded past', () => {
    const premarket: PriceHeaderExtendedQuote = {
      ...afterHours,
      session: 'premarket',
      price: 99.5,
      asOf: '2026-07-27T12:45:00.000Z',
      tradingDate: '2026-07-27',
      freshness: { status: 'cached', asOf: '2026-07-27T12:45:00.000Z', maxAgeSeconds: null },
    };
    // Monday 15:59 ET — the same day's regular session is already under way.
    const regular = quoteResource(HEADER_QUOTE, '2026-07-27T19:59:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-27T20:01:00.000Z',
      serverExtendedQuote: premarket,
    });
    expect(result.extendedQuote).toBeNull();
  });
});

/**
 * Weekend behaviour. Absent PRE/AFTER rows on a Sunday are correct, not a bug:
 * there is no extended session to report. What must never happen is the inverse —
 * Friday's after-hours print resurfacing on Sunday as if it were current.
 */
describe('stock price header weekend and session-date integrity', () => {
  // 2026-07-24 is a Friday; 20:30Z is 16:30 ET, inside Friday's after-hours window.
  const FRIDAY_AFTER_HOURS = '2026-07-24T20:30:00.000Z';
  // 2026-07-26 is a Sunday.
  const SUNDAY = '2026-07-26T17:00:00.000Z';

  it('shows the latest regular close and no extended row on a weekend', () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-24T19:59:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: SUNDAY,
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toBeNull();
  });

  it("does not resurface Friday's after-hours print as Sunday's extended quote", () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-24T19:59:00.000Z');
    const fridayExtended = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      FRIDAY_AFTER_HOURS,
      900,
    );
    const result = resolvePriceHeaderData({
      current: fridayExtended,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: SUNDAY,
    });
    expect(result.extendedQuote).toBeNull();
    expect(result.quote?.price).toBe(HEADER_QUOTE.price);
  });

  it('rejects a weekend-stale extended quote even when the provider declares no max age', () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-24T19:59:00.000Z');
    // An end-of-day feed with maxAgeSeconds: null cannot be aged out by the
    // freshness threshold, so the session gate is the only thing standing between
    // a two-day-old print and the "current price" slot.
    const noMaxAge: StockDetailQuoteResource = {
      ...quoteResource({ ...HEADER_QUOTE, price: 101 }, FRIDAY_AFTER_HOURS),
      freshness: { status: 'end-of-day', asOf: FRIDAY_AFTER_HOURS, maxAgeSeconds: null },
    };
    const result = resolvePriceHeaderData({
      current: noMaxAge,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: SUNDAY,
    });
    expect(result.extendedQuote).toBeNull();
  });

  it('still accepts a genuine same-session after-hours print', () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-24T19:59:00.000Z');
    const live = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      FRIDAY_AFTER_HOURS,
      900,
    );
    const result = resolvePriceHeaderData({
      current: live,
      initial: regular,
      currentSession: 'AFTER_HOURS',
      evaluatedAt: '2026-07-24T20:31:00.000Z',
    });
    expect(result.extendedQuote).toMatchObject({ session: 'after-hours', price: 101 });
    expect(result.quote?.price).toBe(HEADER_QUOTE.price);
  });

  it('accepts a genuine pre-market print and compares it to the prior regular close', () => {
    const regular = quoteResource(HEADER_QUOTE, '2026-07-23T19:59:00.000Z');
    // 2026-07-24T12:00Z is 08:00 ET on a Friday: inside the pre-market window.
    const pre = quoteResource(
      { ...HEADER_QUOTE, price: 99, previousClose: 100, change: -1, changePercent: -1 },
      '2026-07-24T12:00:00.000Z',
      900,
    );
    const result = resolvePriceHeaderData({
      current: pre,
      initial: regular,
      currentSession: 'PREMARKET',
      evaluatedAt: '2026-07-24T12:01:00.000Z',
    });
    expect(result.extendedQuote).toMatchObject({ session: 'premarket', price: 99 });
    expect(result.quote?.price).toBe(HEADER_QUOTE.price);
  });
});

describe('stock price header calculations', () => {
  it.each([
    ['up', '+', '▲', 'positive'],
    ['down', '-', '▼', 'negative'],
    ['neutral', '', null, 'neutral'],
  ] as const)('maps %s to a sign, non-color direction marker, and semantic tone', (direction, sign, arrow, tone) => {
    expect(priceDirectionPresentation(direction)).toEqual({ sign, arrow, tone });
  });

  it('calculates regular change from previous close', () => {
    expect(calculatePriceChange(247.23, 249.89)).toEqual({
      amount: expect.closeTo(-2.66),
      percent: expect.closeTo(-1.0644683660818767),
      direction: 'down',
    });
  });

  it('uses the same regular close base for premarket and after-hours calculations', () => {
    expect(calculatePriceChange(248.1, 247.23)).toEqual({
      amount: expect.closeTo(0.87),
      percent: expect.closeTo(0.351898232415157),
      direction: 'up',
    });
  });

  it('keeps zero change neutral', () => {
    expect(calculatePriceChange(247.23, 247.23)).toEqual({ amount: 0, percent: 0, direction: 'neutral' });
  });

  it.each([
    [0, 200],
    [247.23, 0],
    [247.23, null],
    [Number.NaN, 200],
    [Number.POSITIVE_INFINITY, 200],
    [247.23, Number.NEGATIVE_INFINITY],
  ])('returns unavailable instead of NaN, Infinity, division by zero, or zero fallback', (price, previousClose) => {
    expect(calculatePriceChange(price, previousClose)).toBeNull();
  });

  it('converts USD amounts once while preserving the original percentage', () => {
    const change = calculatePriceChange(247.23, 249.89)!;
    expect(convertUsdForDisplay(247.23, 'THB', 36.5)).toBeCloseTo(9023.895);
    expect(convertUsdForDisplay(change.amount, 'THB', 36.5)).toBeCloseTo(-97.09);
    expect(change.percent).toBeCloseTo(-1.0644683660818767);
  });

  it('keeps USD as source of truth and makes THB unavailable without verified FX', () => {
    expect(convertUsdForDisplay(247.23, 'USD', null)).toBe(247.23);
    expect(convertUsdForDisplay(247.23, 'THB', null)).toBeNull();
    expect(convertUsdForDisplay(247.23, 'THB', 0)).toBeNull();
    expect(convertUsdForDisplay(247.23, 'THB', Number.NaN)).toBeNull();
  });
});

describe('stock price header regular change resolution', () => {
  it.each([
    [11.475, 10.92, 0.555, 5.08, 'up'],
    [11.445, 12.03, -0.585, -4.86, 'down'],
  ] as const)('derives %s against canonical previous close %s', (price, previousClose, amount, percent, direction) => {
    const resolved = resolvePriceChange({
      price,
      previousClose,
      // Deliberately wrong provider values: they describe a stale price and
      // must never override arithmetic from the accepted price.
      providerChange: 99,
      providerChangePercent: 99,
    });
    expect(resolved?.amount).toBeCloseTo(amount, 10);
    expect(resolved?.percent).toBeCloseTo(percent, 2);
    expect(resolved?.direction).toBe(direction);
  });

  it('is unavailable when the canonical previous close is missing', () => {
    expect(resolvePriceChange({
      price: 69.75,
      previousClose: null,
      providerChange: -2.7,
      providerChangePercent: -3.73,
    })).toBeNull();
  });

  it('derives the change from a real previous close when the provider sent none', () => {
    expect(resolvePriceChange({
      price: 248.1,
      previousClose: 247.23,
      providerChange: null,
      providerChangePercent: null,
    })).toEqual({
      amount: expect.closeTo(0.87),
      percent: expect.closeTo(0.351898232415157),
      direction: 'up',
    });
  });

  it('keeps a zero change neutral from the canonical base', () => {
    expect(resolvePriceChange({
      price: 100,
      previousClose: 100,
      providerChange: 0,
      providerChangePercent: 0,
    })).toEqual({ amount: 0, percent: 0, direction: 'neutral' });
    expect(resolvePriceChange({
      price: 100,
      previousClose: 100,
      providerChange: null,
      providerChangePercent: null,
    })).toEqual({ amount: 0, percent: 0, direction: 'neutral' });
  });

  it('never fabricates a change without a real base', () => {
    // previousClose null/0 always hides the derived values.
    expect(resolvePriceChange({ price: 69.75, previousClose: null, providerChange: null, providerChangePercent: null })).toBeNull();
    expect(resolvePriceChange({ price: 69.75, previousClose: 0, providerChange: null, providerChangePercent: null })).toBeNull();
    // A lone finite change with a non-finite percent is not enough to show truthfully.
    expect(resolvePriceChange({ price: 69.75, previousClose: null, providerChange: -2.7, providerChangePercent: null })).toBeNull();
  });

  it('returns null when the price itself is missing or non-tradeable', () => {
    expect(resolvePriceChange({ price: null, previousClose: 72.45, providerChange: -2.7, providerChangePercent: -3.73 })).toBeNull();
    expect(resolvePriceChange({ price: 0, previousClose: 72.45, providerChange: -2.7, providerChangePercent: -3.73 })).toBeNull();
    expect(resolvePriceChange({ price: Number.NaN, previousClose: 72.45, providerChange: -2.7, providerChangePercent: -3.73 })).toBeNull();
  });
});

describe('stock price header live flash direction', () => {
  it('flashes up when the tick rises and down when it falls', () => {
    expect(priceFlashDirection(247.23, 248.1)).toBe('up');
    expect(priceFlashDirection(248.1, 247.23)).toBe('down');
  });

  it('does not flash when the price is unchanged or has no prior value', () => {
    expect(priceFlashDirection(247.23, 247.23)).toBeNull();
    expect(priceFlashDirection(null, 247.23)).toBeNull();
    expect(priceFlashDirection(undefined, 247.23)).toBeNull();
    expect(priceFlashDirection(247.23, null)).toBeNull();
  });

  it.each([
    [Number.NaN, 248.1],
    [247.23, Number.POSITIVE_INFINITY],
    [0, 248.1],
    [247.23, 0],
    [-1, 248.1],
  ])('never flashes on non-finite or non-positive values', (previous, next) => {
    expect(priceFlashDirection(previous, next)).toBeNull();
  });
});

describe('stock price header currency resolution', () => {
  it('uses profile, quote, instrument metadata, then trusted exchange mapping', () => {
    expect(resolvePriceCurrency({
      profileCurrency: ' thb ',
      quoteCurrency: 'usd',
      instrumentCurrency: 'JPY',
      exchange: 'NASDAQ',
    })).toEqual({ currency: 'THB', source: 'profile' });
    expect(resolvePriceCurrency({
      profileCurrency: null,
      quoteCurrency: 'usd',
      instrumentCurrency: 'JPY',
      exchange: 'NASDAQ',
    })).toEqual({ currency: 'USD', source: 'quote' });
    expect(resolvePriceCurrency({
      profileCurrency: null,
      quoteCurrency: null,
      instrumentCurrency: 'jpy',
      exchange: 'NASDAQ',
    })).toEqual({ currency: 'JPY', source: 'instrument' });
    expect(resolvePriceCurrency({
      profileCurrency: null,
      quoteCurrency: null,
      instrumentCurrency: null,
      exchange: 'NYSE Arca',
    })).toEqual({ currency: 'USD', source: 'exchange' });
  });

  it('does not guess a currency from an unknown exchange', () => {
    expect(resolvePriceCurrency({
      profileCurrency: null,
      quoteCurrency: null,
      instrumentCurrency: null,
      exchange: 'UNKNOWN',
    })).toEqual({ currency: null, source: null });
  });
});

describe('connection status presentation mapping', () => {
  it('maps every typed connection state to the right indicator', () => {
    expect(connectionStatusPresentation('connecting')).toEqual({
      kind: 'connecting',
      label: 'กำลังเชื่อมต่อ',
    });
    expect(connectionStatusPresentation('connected')).toEqual({ kind: 'none' });
    // awaiting-data → a calm "connected, waiting for live data" pill (NOT an error):
    // the socket is open, just no tick yet. This is the state that used to be
    // mislabelled "การเชื่อมต่อขัดข้อง" while the WS was actually connected.
    expect(connectionStatusPresentation('awaiting-data')).toEqual({
      kind: 'awaiting',
      label: 'เชื่อมต่อแล้ว · รอข้อมูลสด',
    });
    // reconnecting → concise pill with the Thai "reconnecting" label.
    expect(connectionStatusPresentation('reconnecting')).toEqual({
      kind: 'reconnecting',
      label: 'กำลังเชื่อมต่อใหม่',
    });
    // degraded and disconnected both surface the same explicit offline text.
    expect(connectionStatusPresentation('degraded')).toEqual({
      kind: 'error',
      label: 'ออฟไลน์',
    });
    expect(connectionStatusPresentation('disconnected')).toEqual({
      kind: 'error',
      label: 'ออฟไลน์',
    });
  });

  it('renders no indicator for a REST-only deployment (null/undefined)', () => {
    expect(connectionStatusPresentation(null)).toEqual({ kind: 'none' });
    expect(connectionStatusPresentation(undefined)).toEqual({ kind: 'none' });
  });
});

describe('stock price header session date labels', () => {
  it('formats an exchange-local DD/MM from an ISO instant', () => {
    // 20:00Z on 24 July is 16:00 ET the SAME day — the session it belongs to.
    expect(formatSessionDateLabel('2026-07-24T20:00:00.000Z')).toBe('24/07');
    // 23:59Z is still 19:59 ET on the 24th, inside Friday's after-hours window.
    expect(formatSessionDateLabel('2026-07-24T23:59:00.000Z')).toBe('24/07');
    // 01:00Z on the 25th is 21:00 ET on the 24th — still the 24th's session.
    expect(formatSessionDateLabel('2026-07-25T01:00:00.000Z')).toBe('24/07');
  });

  it('passes an already-resolved trading date straight through', () => {
    expect(formatSessionDateLabel('2026-07-17')).toBe('17/07');
  });

  it('returns null for a missing or unparseable value', () => {
    expect(formatSessionDateLabel(null)).toBeNull();
    expect(formatSessionDateLabel(undefined)).toBeNull();
    expect(formatSessionDateLabel('not-a-date')).toBeNull();
  });

  it('names the session a price was printed in for the provenance detail', () => {
    expect(priceSessionLabel('2026-07-24T14:00:00.000Z')).toContain('Regular');
    expect(priceSessionLabel('2026-07-24T11:00:00.000Z')).toContain('Pre-market');
    expect(priceSessionLabel('2026-07-24T21:00:00.000Z')).toContain('After-hours');
    expect(priceSessionLabel('2026-07-26T17:00:00.000Z')).toContain('Closed');
    expect(priceSessionLabel(null)).toContain('ไม่ทราบ');
  });
});

describe('stock price header server-resolved extended quote', () => {
  const FRIDAY_CLOSE = '2026-07-24T20:00:00.000Z';
  const SUNDAY = '2026-07-26T17:00:00.000Z';

  function serverExtended(overrides: Partial<PriceHeaderExtendedQuote> = {}): PriceHeaderExtendedQuote {
    return {
      session: 'after-hours',
      price: 206.6,
      asOf: '2026-07-24T23:55:00.000Z',
      tradingDate: '2026-07-24',
      freshness: { status: 'delayed', asOf: '2026-07-24T23:55:00.000Z', maxAgeSeconds: null },
      provider: 'yahoo-finance-chart',
      ...overrides,
    };
  }

  // Production shape: Polygon stamps the close at exactly 20:00:00Z (16:00 ET),
  // which the session classifier treats as an after-hours instant, and supplies
  // `regularClose` separately. That pairing is what keeps the regular close in
  // the primary row instead of falling back to the previous close.
  const regularClose: Quote = {
    ...HEADER_QUOTE, price: 206.87, regularClose: 206.87,
    previousClose: 208.76, previousRegularClose: 208.76,
  };

  it("shows the latest session's after-hours row on a Sunday, with its own date", () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: SUNDAY,
      serverExtendedQuote: serverExtended(),
    });

    // The primary row is untouched: the extended print never overwrites it.
    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).not.toBeNull();
    expect(result.extendedQuote!.session).toBe('after-hours');
    expect(result.extendedQuote!.price).toBe(206.6);
    expect(result.extendedQuote!.tradingDate).toBe('2026-07-24');
    // Never claimed as live.
    expect(result.extendedQuote!.freshness.status).toBe('delayed');
  });

  it('rejects an extended print from an older session than the primary row', () => {
    const regular = quoteResource(regularClose, '2026-07-27T20:00:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: '2026-07-27T22:00:00.000Z',
      // Friday's print beside Monday's close: stale, must not render.
      serverExtendedQuote: serverExtended(),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).toBeNull();
  });

  /**
   * The production shape of the reported defect: Monday's pre-market print beside
   * Friday's close. A pre-market print NEVER shares the trading date of the
   * regular close above it, so requiring one date deleted this row every morning.
   */
  it('shows a pre-market row beside the latest completed regular close', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'PREMARKET',
      evaluatedAt: '2026-07-27T12:00:00.000Z',
      serverExtendedQuote: serverExtended({
        session: 'premarket', price: 208.1,
        asOf: '2026-07-27T11:45:00.000Z', tradingDate: '2026-07-27',
      }),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote!.session).toBe('premarket');
    expect(result.extendedQuote!.price).toBe(208.1);
  });

  it('prefers an accepted pipeline extended print over the server one', () => {
    // 2026-07-24 20:30Z is 16:30 ET — inside Friday's after-hours window.
    const accepted = quoteResource({ ...HEADER_QUOTE, price: 207.4, regularClose: 206.87 }, '2026-07-24T20:30:00.000Z');
    const result = resolvePriceHeaderData({
      current: accepted,
      initial: accepted,
      currentSession: 'AFTER_HOURS',
      evaluatedAt: '2026-07-24T20:35:00.000Z',
      serverExtendedQuote: serverExtended(),
    });

    expect(result.extendedQuote!.price).toBe(207.4);
    expect(result.extendedQuote!.provider).toBe('polygon');
    // The regular close still holds the primary row.
    expect(result.quote!.price).toBe(206.87);
  });

  it('hides the extended row during the regular session', () => {
    const regular = quoteResource(regularClose, '2026-07-24T15:00:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'REGULAR',
      evaluatedAt: '2026-07-24T15:01:00.000Z',
      // Even if one were supplied, its trading date matches, but the caller
      // resolves none mid-session; passing null must keep the row hidden.
      serverExtendedQuote: null,
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).toBeNull();
  });

  it('stays backwards compatible when no server extended quote is supplied', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'CLOSED',
      evaluatedAt: SUNDAY,
    });

    expect(result.extendedQuote).toBeNull();
  });

  /**
   * The production defect, reproduced at the partition layer: a stale/derived
   * "open" session with a valid same-date after-hours print produced the
   * contradictory "☀️ ตลาดเปิด" + "🌙 หลังเวลาทำการ" pair. The row must be
   * dropped by the session, not by the print's own validity.
   */
  it('B: drops a perfectly valid extended print while the session is REGULAR', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'REGULAR',
      evaluatedAt: '2026-07-24T17:00:00.000Z',
      serverExtendedQuote: serverExtended(),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).toBeNull();
  });

  it('B: drops the extended row while a symbol is halted mid-session', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'HALTED',
      evaluatedAt: '2026-07-24T17:00:00.000Z',
      serverExtendedQuote: serverExtended(),
    });

    expect(result.extendedQuote).toBeNull();
  });

  it('keeps the dated after-hours row on a market holiday', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'HOLIDAY',
      evaluatedAt: '2026-07-27T17:00:00.000Z',
      serverExtendedQuote: serverExtended(),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote!.tradingDate).toBe('2026-07-24');
  });

  /**
   * §3 persistence at the resolver: the SAME inputs, evaluated once inside the
   * after-hours window and once after it ended. Only the clock moved, so only
   * the freshness LABEL may move with it — the row itself must survive.
   */
  it('keeps the after-hours row when the session ends and the market goes closed', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const inputs = { current: regular, initial: regular, serverExtendedQuote: serverExtended() };

    const duringSession = resolvePriceHeaderData({
      ...inputs, currentSession: 'AFTER_HOURS', evaluatedAt: '2026-07-24T23:56:00.000Z',
    });
    const afterSession = resolvePriceHeaderData({
      ...inputs, currentSession: 'CLOSED', evaluatedAt: '2026-07-25T02:00:00.000Z',
    });

    expect(duringSession.extendedQuote!.price).toBe(206.6);
    expect(afterSession.extendedQuote!.price).toBe(206.6);
    expect(afterSession.extendedQuote!.session).toBe('after-hours');
    expect(afterSession.extendedQuote!.tradingDate).toBe('2026-07-24');
    // And the primary row is still the regular close, never the extended print.
    expect(afterSession.quote!.price).toBe(206.87);
  });

  /**
   * §3 again, against the refresh that actually erased the row in production: a
   * regular snapshot re-received on a LATER date must not delete a pre-market
   * print, because a pre-market print is always dated after the close beside it.
   */
  it('survives a snapshot refresh that advances the regular timestamp', () => {
    const premarket = serverExtended({
      session: 'premarket', price: 208.1,
      asOf: '2026-07-27T11:45:00.000Z', tradingDate: '2026-07-27',
    });
    const stale = quoteResource(regularClose, FRIDAY_CLOSE);
    const refreshed = quoteResource(regularClose, '2026-07-27T11:50:00.000Z');

    for (const current of [stale, refreshed]) {
      const result = resolvePriceHeaderData({
        current, initial: stale, currentSession: 'PREMARKET',
        evaluatedAt: '2026-07-27T12:00:00.000Z', serverExtendedQuote: premarket,
      });
      expect(result.extendedQuote!.price).toBe(208.1);
    }
  });

  it('shows no extended row when the current session could not be resolved', () => {
    const regular = quoteResource(regularClose, FRIDAY_CLOSE);
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      currentSession: 'UNKNOWN',
      evaluatedAt: SUNDAY,
      serverExtendedQuote: serverExtended(),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).toBeNull();
  });
});

/**
 * The final model the header renders. Its job is to carry the resolved session
 * through untouched and to fix the comparison base of each row (§5/§6/§11).
 */
describe('stock price header final model', () => {
  const FRIDAY_CLOSE = '2026-07-24T20:00:00.000Z';
  const regularClose: Quote = {
    ...HEADER_QUOTE, price: 206.87, regularClose: 206.87,
    previousClose: 208.76, previousRegularClose: 208.76,
    change: -1.89, changePercent: -0.91,
  };
  const afterHoursRow: PriceHeaderExtendedQuote = {
    session: 'after-hours',
    price: 206.7995,
    asOf: '2026-07-24T23:55:00.000Z',
    tradingDate: '2026-07-24',
    freshness: { status: 'delayed', asOf: '2026-07-24T23:55:00.000Z', maxAgeSeconds: null },
    provider: 'yahoo-finance-chart',
  };

  function model(currentSession: Parameters<typeof buildStockPriceHeaderModel>[0]['currentSession'], extended: PriceHeaderExtendedQuote | null) {
    return buildStockPriceHeaderModel({
      data: {
        quote: regularClose,
        freshness: { status: 'end-of-day', asOf: FRIDAY_CLOSE, maxAgeSeconds: null },
        provider: 'polygon',
        fallbackLabel: null,
        extendedQuote: extended,
      },
      currentSession,
      currentSessionEvaluatedAt: '2026-07-26T17:00:00.000Z',
      currentSessionSource: 'exchange-calendar',
    });
  }

  it('carries the resolved session and its evaluation instant through untouched', () => {
    const result = model('CLOSED', afterHoursRow);
    expect(result.currentSession).toBe('CLOSED');
    expect(result.currentSessionEvaluatedAt).toBe('2026-07-26T17:00:00.000Z');
    // The DATA timestamp is a separate field and is two days older — proving the
    // two are not the same value and neither is derived from the other.
    expect(result.regular.asOf).toBe(FRIDAY_CLOSE);
    expect(result.extended!.asOf).toBe('2026-07-24T23:55:00.000Z');
  });

  it('C: computes the after-hours change against the regular close beside it', () => {
    const result = model('CLOSED', afterHoursRow);
    // 206.7995 − 206.87 = −0.0705 (−0.03%), the exact production figures.
    expect(result.extended!.change!.amount).toBeCloseTo(-0.0705, 4);
    expect(result.extended!.change!.percent).toBeCloseTo(-0.0341, 3);
    expect(result.extended!.change!.direction).toBe('down');
  });

  it('D: computes the pre-market change against the previous regular close in the main row', () => {
    const result = model('PREMARKET', {
      ...afterHoursRow, session: 'premarket', price: 208.1, asOf: '2026-07-27T12:45:00.000Z',
    });
    expect(result.extended!.change!.amount).toBeCloseTo(208.1 - 206.87, 4);
    expect(result.extended!.change!.direction).toBe('up');
  });

  it('keeps the provider daily change on the primary row', () => {
    const result = model('CLOSED', null);
    expect(result.regular.price).toBe(206.87);
    expect(result.regular.previousClose).toBe(208.76);
    expect(result.regular.change!.amount).toBeCloseTo(-1.89, 2);
    expect(result.regular.change!.percent).toBeCloseTo(-0.91, 2);
  });

  it('B: refuses to carry an extended row while the market is REGULAR', () => {
    expect(model('REGULAR', afterHoursRow).extended).toBeNull();
    expect(model('HALTED', afterHoursRow).extended).toBeNull();
  });
});
