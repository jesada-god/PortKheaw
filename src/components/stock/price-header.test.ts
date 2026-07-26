import { describe, expect, it } from 'vitest';
import type { Quote } from '@/src/lib/market-data/types';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';
import {
  calculatePriceChange,
  connectionStatusPresentation,
  convertUsdForDisplay,
  dataStatusPresentation,
  deriveMarketSession,
  marketSessionPresentation,
  priceDirectionPresentation,
  priceFlashDirection,
  resolvePriceChange,
  resolvePriceCurrency,
  resolveDataStatus,
  resolveMarketSession,
  resolvePriceHeaderData,
  formatSessionDateLabel,
  priceSessionLabel,
  type PriceHeaderExtendedQuote,
} from './price-header';

describe('stock price header market session mapping', () => {
  it('preserves provider extended, holiday and early-close states', () => {
    expect(deriveMarketSession({ currentStatus: 'pre-market', notes: null })).toBe('premarket');
    expect(deriveMarketSession({ currentStatus: 'after-hours', notes: null })).toBe('after-hours');
    expect(deriveMarketSession({ currentStatus: 'holiday', notes: null })).toBe('holiday');
    expect(deriveMarketSession({ currentStatus: 'early-close', notes: null })).toBe('early-close');
  });

  it.each([
    ['premarket', '🌅', 'ก่อนตลาดเปิด'],
    ['open', '☀️', 'ตลาดเปิด'],
    ['after-hours', '🌇', 'หลังเวลาทำการ'],
    ['closed', '🌙', 'ปิดตลาด'],
    ['holiday', '📅', 'วันหยุดตลาด'],
    ['halted', '⏸️', 'ระงับการซื้อขาย'],
    ['unknown', '⚠️', 'ไม่ทราบสถานะตลาด'],
  ] as const)('maps %s to a stable emoji and Thai label', (session, emoji, label) => {
    expect(marketSessionPresentation(session)).toEqual(expect.objectContaining({ emoji, label }));
  });

  it('gives trading halts and holidays priority over an open market', () => {
    expect(resolveMarketSession({ halted: true, regularOpen: true })).toBe('halted');
    expect(resolveMarketSession({ holiday: true, regularOpen: true })).toBe('holiday');
    expect(resolveMarketSession({ halted: true, holiday: true, regularOpen: true })).toBe('halted');
  });

  it('uses the required session priority order', () => {
    expect(resolveMarketSession({ premarket: true, regularOpen: true, afterHours: true })).toBe('premarket');
    expect(resolveMarketSession({ regularOpen: true, afterHours: true })).toBe('open');
    expect(resolveMarketSession({ afterHours: true, closed: true })).toBe('after-hours');
    expect(resolveMarketSession({ closed: true })).toBe('closed');
    expect(resolveMarketSession({})).toBe('unknown');
  });

  it('derives halt and holiday only from explicit normalized provider notes', () => {
    expect(deriveMarketSession({ currentStatus: 'open', notes: 'Trading halted pending news' })).toBe('halted');
    expect(deriveMarketSession({ currentStatus: 'closed', notes: 'US market holiday' })).toBe('holiday');
    expect(deriveMarketSession({ currentStatus: 'closed', notes: null })).toBe('closed');
  });
});

describe('stock price header data status mapping', () => {
  it.each([
    ['delayed', '⏱️', 'ข้อมูลล่าช้า'],
    ['cached', '💾', 'ข้อมูลแคช'],
    ['stale', '🕒', 'ข้อมูลเก่า'],
    ['unavailable', '⚠️', 'ไม่มีข้อมูลราคา'],
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
      marketStatus: 'open',
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
      marketStatus: 'pre-market',
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
      marketStatus: 'after-hours',
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
      marketStatus: 'after-hours',
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
      marketStatus: 'after-hours',
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
      marketStatus: 'closed',
      evaluatedAt: '2026-07-20T20:00:10.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
    expect(result.extendedQuote).toBeNull();
  });

  it('never presents a stale extended quote as current or as a secondary quote', () => {
    const initial = quoteResource(HEADER_QUOTE, '2026-07-20T19:59:00.000Z');
    const current = quoteResource(
      { ...HEADER_QUOTE, price: 101, previousClose: 100, change: 1, changePercent: 1 },
      '2026-07-20T21:00:00.000Z',
      60,
    );
    const result = resolvePriceHeaderData({
      current,
      initial,
      marketStatus: 'closed',
      evaluatedAt: '2026-07-20T21:02:00.000Z',
    });
    expect(result.quote).toBe(HEADER_QUOTE);
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
      marketStatus: 'closed',
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
      marketStatus: 'closed',
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
      marketStatus: 'closed',
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
      marketStatus: 'after-hours',
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
      marketStatus: 'pre-market',
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
  it('trusts the provider change/percent when both are finite', () => {
    expect(resolvePriceChange({
      price: 69.75,
      previousClose: 72.45,
      providerChange: -2.7,
      providerChangePercent: -3.73,
    })).toEqual({ amount: -2.7, percent: -3.73, direction: 'down' });
  });

  it('shows the provider change even when the provider omitted the previous close', () => {
    // The exact production defect: Polygon returned todaysChange/todaysChangePerc
    // but no prevDay close, so previousClose is null. The change must still show.
    expect(resolvePriceChange({
      price: 69.75,
      previousClose: null,
      providerChange: -2.7,
      providerChangePercent: -3.73,
    })).toEqual({ amount: -2.7, percent: -3.73, direction: 'down' });
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

  it('keeps a zero change neutral from either source', () => {
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

  it('never fabricates a change when neither a provider change nor a real base exists', () => {
    // previousClose null/0 and no provider change → hide (return null).
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
    // connecting/connected stay neutral: connected relies on the existing
    // Real-time badge, connecting shows only the untouched freshness status.
    expect(connectionStatusPresentation('connecting')).toEqual({ kind: 'none' });
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
      label: 'กำลังเชื่อมต่อใหม่…',
    });
    // degraded and disconnected both surface the same "connection problem" text.
    expect(connectionStatusPresentation('degraded')).toEqual({
      kind: 'error',
      label: 'การเชื่อมต่อขัดข้อง',
    });
    expect(connectionStatusPresentation('disconnected')).toEqual({
      kind: 'error',
      label: 'การเชื่อมต่อขัดข้อง',
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
      marketStatus: 'closed',
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
      marketStatus: 'closed',
      evaluatedAt: '2026-07-27T22:00:00.000Z',
      // Friday's print beside Monday's close: stale, must not render.
      serverExtendedQuote: serverExtended(),
    });

    expect(result.quote!.price).toBe(206.87);
    expect(result.extendedQuote).toBeNull();
  });

  it('shows a pre-market row beside the latest completed regular close', () => {
    const regular = quoteResource(regularClose, '2026-07-27T20:00:00.000Z');
    const result = resolvePriceHeaderData({
      current: regular,
      initial: regular,
      marketStatus: 'pre-market',
      evaluatedAt: '2026-07-28T11:00:00.000Z',
      serverExtendedQuote: serverExtended({
        session: 'premarket', price: 208.1,
        asOf: '2026-07-27T12:45:00.000Z', tradingDate: '2026-07-27',
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
      marketStatus: 'after-hours',
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
      marketStatus: 'open',
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
      marketStatus: 'closed',
      evaluatedAt: SUNDAY,
    });

    expect(result.extendedQuote).toBeNull();
  });
});
