import { describe, expect, it } from 'vitest';
import type { Quote } from '@/src/lib/market-data/types';
import type { SnapshotExtendedInput } from '@/src/lib/market-data/market-snapshot';
import { quoteResource, sessionResult, snapshotOf } from '@/src/test/fixtures/market-snapshot';
import {
  calculatePriceChange,
  comparisonBaseLabel,
  connectionStatusPresentation,
  convertUsdForDisplay,
  dataStatusPresentation,
  extendedSessionPresentation,
  mainPriceRoleLabel,
  priceDirectionPresentation,
  priceFlashDirection,
  preserveLastKnownExtendedQuote,
  resolvePriceChange,
  resolvePriceCurrency,
  resolveDataStatus,
  buildStockPriceHeaderModel,
  formatSessionDateLabel,
  priceSessionLabel,
  type PriceHeaderExtendedQuote,
} from './price-header';

/**
 * Presentation-layer tests for the header.
 *
 * The PRICE and SESSION rules themselves live in `market-snapshot.test.ts`, against
 * the one resolver that decides them. What is verified here is the PROJECTION: that
 * the header model copies the snapshot's answers without re-deciding any of them,
 * plus the pure formatting and labelling helpers.
 */

describe('stock price header extended-row session labels', () => {
  it.each([
    ['premarket', 'wb_twilight', 'pre', 'ก่อนเปิดตลาด'],
    // `bedtime`, matching the POST session icon: an after-hours row and the
    // after-hours session are the same fact seen from two places.
    ['after-hours', 'bedtime', 'post', 'หลังปิดตลาด'],
  ] as const)('maps %s to a Material Symbols glyph, a tone and a Thai label', (session, icon, tone, label) => {
    expect(extendedSessionPresentation(session)).toEqual(expect.objectContaining({ icon, tone, label }));
  });

  it('describes every extended row in Thai, for its tooltip and accessible name', () => {
    for (const session of ['premarket', 'after-hours'] as const) {
      expect(extendedSessionPresentation(session).description.length).toBeGreaterThan(10);
    }
  });
});

describe('stock price header data status mapping', () => {
  it.each([
    ['live', null, 'ราคาสด'],
    ['delayed', '⏱️', 'ราคาล่าช้า'],
    ['cached', '💾', 'ข้อมูลที่บันทึกไว้'],
    ['stale', '🕒', 'ข้อมูลอาจล่าช้า'],
    ['closed', null, 'ราคาปิดทางการ'],
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

describe('comparison-base and main-price labels', () => {
  it('names what each change is measured against', () => {
    expect(comparisonBaseLabel('previous-regular-close')).toContain('วันซื้อขายก่อนหน้า');
    expect(comparisonBaseLabel('regular-close')).toContain('ราคาปิดจริง');
    expect(comparisonBaseLabel(null)).toContain('ไม่มีฐานเปรียบเทียบ');
  });

  it('names what the main price IS, so a close is never read as a live price', () => {
    expect(mainPriceRoleLabel('regular')).toContain('เวลาทำการปกติ');
    expect(mainPriceRoleLabel('regular-close')).toContain('ราคาปิดจริง');
    expect(mainPriceRoleLabel(null)).toContain('ไม่พบราคา');
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
  previousRegularClose: 98,
  regularClose: 100,
  change: 2,
  changePercent: (2 / 98) * 100,
  volume: 1_000,
  latestTradingDay: '2026-07-20',
  quoteTimestamp: '2026-07-20T14:00:00.000Z',
};

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


/**
 * The model is a PROJECTION of the snapshot. These tests assert exactly that: each
 * displayed field traces to a snapshot field, and the only arithmetic performed is
 * the two changes, each against the base the snapshot named.
 */
describe('stock price header final model', () => {
  const FRIDAY_CLOSE = '2026-07-24T20:00:00.000Z';
  const SUNDAY = '2026-07-26T17:00:00.000Z';
  /** Friday 19:56 ET — inside the after-hours window the print below belongs to. */
  const FRIDAY_POST = '2026-07-24T23:56:00.000Z';
  const regularClose: Quote = {
    ...HEADER_QUOTE, price: 206.87, regularClose: 206.87,
    previousClose: 208.76, previousRegularClose: 208.76,
    change: -1.89, changePercent: -0.91,
    latestTradingDay: '2026-07-24', quoteTimestamp: FRIDAY_CLOSE,
  };
  const afterHoursRow: SnapshotExtendedInput = {
    session: 'after-hours',
    price: 206.7995,
    asOf: '2026-07-24T23:55:00.000Z',
    tradingDate: '2026-07-24',
    freshness: { status: 'delayed', asOf: '2026-07-24T23:55:00.000Z', maxAgeSeconds: null },
    provider: 'yahoo-finance-chart',
  };

  function model(
    session: Parameters<typeof sessionResult>[0],
    extended: SnapshotExtendedInput | null,
    options: { now?: string; exchangeDate?: string; quote?: Quote } = {},
  ) {
    const now = options.now ?? SUNDAY;
    const quote = options.quote ?? regularClose;
    return buildStockPriceHeaderModel({
      snapshot: snapshotOf({
        symbol: 'AAPL',
        session: sessionResult(session, {
          evaluatedAt: now,
          exchangeDate: options.exchangeDate ?? now.slice(0, 10),
        }),
        quote: quoteResource(quote, {
          status: 'end-of-day', asOf: quote.quoteTimestamp ?? FRIDAY_CLOSE, maxAgeSeconds: null,
        }),
        extended,
        now,
      }),
      evaluatedAt: now,
    });
  }

  it('carries the resolved session and its evaluation instant through untouched', () => {
    const result = model('CLOSED', null);
    expect(result.session).toBe('CLOSED');
    expect(result.sessionLabel).toBe('CLOSED');
    expect(result.currentSessionEvaluatedAt).toBe(SUNDAY);
    // The DATA timestamp is a separate field and is two days older — proving the
    // two are not the same value and neither is derived from the other.
    expect(result.main.asOf).toBe(FRIDAY_CLOSE);
  });

  it('C: computes the after-hours change against the regular close beside it', () => {
    const result = model('AFTER_HOURS', afterHoursRow, { now: FRIDAY_POST, exchangeDate: '2026-07-24' });
    // 206.7995 - 206.87 = -0.0705 (-0.03%), the exact production figures.
    expect(result.secondary!.asOf).toBe('2026-07-24T23:55:00.000Z');
    expect(result.secondary!.comparisonBaseKind).toBe('regular-close');
    expect(result.secondary!.comparisonBase).toBe(206.87);
    expect(result.secondary!.change!.amount).toBeCloseTo(-0.0705, 4);
    expect(result.secondary!.change!.percent).toBeCloseTo(-0.0341, 3);
    expect(result.secondary!.change!.direction).toBe('down');
  });

  /**
   * PRE's second row is measured from the SAME base as POST's — `regularClose`, the
   * latest completed close — which before the bell is the previous session's. The
   * main row shows that close, so the row reads as "the move since that number".
   */
  it('computes the pre-market change against the completed close on the main row', () => {
    const result = model('PREMARKET', {
      session: 'premarket',
      price: 208.1,
      asOf: '2026-07-27T11:45:00.000Z',
      tradingDate: '2026-07-27',
      freshness: { status: 'delayed', asOf: '2026-07-27T11:45:00.000Z', maxAgeSeconds: 900 },
      provider: 'yahoo-finance-chart',
    }, { now: '2026-07-27T12:00:00.000Z', exchangeDate: '2026-07-27' });

    expect(result.main.price).toBe(206.87);
    expect(result.main.role).toBe('regular-close');
    expect(result.main.comparisonBase).toBe(208.76);
    expect(result.secondary!.session).toBe('premarket');
    expect(result.secondary!.comparisonBaseKind).toBe('regular-close');
    expect(result.secondary!.comparisonBase).toBe(206.87);
    expect(result.secondary!.change!.amount).toBeCloseTo(1.23, 4);
    expect(result.secondary!.change!.direction).toBe('up');
  });

  it('hides the secondary row once the market is CLOSED, however valid the print', () => {
    const result = model('CLOSED', afterHoursRow);
    expect(result.main.price).toBe(206.87);
    expect(result.secondary).toBeNull();
    expect(result.snapshot.flags).toContain('extended-window-closed');
  });

  it('computes the main change against the previous regular close', () => {
    const result = model('CLOSED', null);
    expect(result.main.price).toBe(206.87);
    expect(result.main.role).toBe('regular-close');
    expect(result.main.comparisonBase).toBe(208.76);
    expect(result.main.comparisonBaseKind).toBe('previous-regular-close');
    expect(result.main.change!.amount).toBeCloseTo(-1.89, 2);
    expect(result.main.change!.percent).toBeCloseTo(-0.91, 2);
  });

  it('reports a finalized close as an official close rather than ageing it into stale', () => {
    expect(model('CLOSED', null).main.status).toBe('closed');
  });

  it('B: refuses to carry a secondary row while the market is REGULAR', () => {
    const now = '2026-07-24T17:00:00.000Z'; // Friday 13:00 ET
    const quote: Quote = { ...regularClose, quoteTimestamp: now, latestTradingDay: '2026-07-24' };
    expect(model('REGULAR', afterHoursRow, { now, exchangeDate: '2026-07-24', quote }).secondary).toBeNull();
    expect(model('HALTED', afterHoursRow, { now, exchangeDate: '2026-07-24', quote }).secondary).toBeNull();
  });

  it('hides the secondary row entirely rather than showing a fabricated 0.00%', () => {
    const result = model('CLOSED', null);
    expect(result.secondary).toBeNull();
    expect(result.snapshot.extendedPrice).toBeNull();
  });

  it('matches the NVTS regular/after-hours arithmetic contract exactly', () => {
    const now = '2026-07-27T21:05:01.000Z'; // Monday 17:05 ET
    const result = model('AFTER_HOURS', {
      session: 'after-hours',
      price: 11.08,
      asOf: '2026-07-27T21:05:00.000Z',
      tradingDate: '2026-07-27',
      freshness: { status: 'delayed', asOf: '2026-07-27T21:05:00.000Z', maxAgeSeconds: 900 },
      provider: 'yahoo-finance-chart',
    }, {
      now,
      exchangeDate: '2026-07-27',
      quote: {
        ...regularClose,
        price: 11.41,
        regularClose: 11.41,
        previousClose: 10.92,
        previousRegularClose: 10.92,
        latestTradingDay: '2026-07-27',
        quoteTimestamp: '2026-07-27T20:00:01.000Z',
      },
    });

    expect(result.main.price).toBe(11.41);
    expect(result.main.change?.amount).toBeCloseTo(0.49);
    expect(result.main.change?.percent).toBeCloseTo(4.487179);
    expect(result.secondary?.price).toBe(11.08);
    expect(result.secondary?.change?.amount).toBeCloseTo(-0.33);
    expect(result.secondary?.change?.percent).toBeCloseTo(-2.8922);
  });
});
