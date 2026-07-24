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
    expect(result.quote?.change).toBeNull();
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

  it('keeps a genuine Alpaca real-time snapshot primary after hours', () => {
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
    expect(result.quote?.price).toBe(206.87);
    expect(result.provider).toBe('alpaca:iex');
    expect(result.fallbackLabel).toBeNull();
    expect(result.extendedQuote).toBeNull();
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
