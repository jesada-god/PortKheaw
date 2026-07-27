import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  activityMetrics,
  buildStrikeRows,
  computeVirtualWindow,
  formatMoney,
  formatNumber,
  formatPercent,
  greekMetrics,
  hasAnyGreek,
  isAtmStrike,
  isOutsideExpectedMove,
  moneyness,
  priceMetrics,
  UNAVAILABLE,
} from './options-chain-view';

const AS_OF = '2026-07-27T13:30:00.000Z';
const EXPIRATION = '2026-08-21';

function contract(overrides: Partial<OptionContract> & Pick<OptionContract, 'type' | 'strike'>): OptionContract {
  return {
    contractSymbol: `AAPL${EXPIRATION.replace(/-/g, '').slice(2)}${overrides.type === 'call' ? 'C' : 'P'}00${overrides.strike}000`,
    underlyingSymbol: 'AAPL',
    expiration: EXPIRATION,
    bid: null, ask: null, last: null, mark: null,
    volume: null, openInterest: null, impliedVolatility: null,
    delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD',
    provider: 'alpaca', marketDataProvider: null, marketDataFeed: null,
    asOf: AS_OF, oiAsOf: null, timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: null, valuationSource: null,
    ...overrides,
  };
}

describe('formatting', () => {
  it('renders a missing value as the single unavailable glyph, never as zero', () => {
    expect(formatNumber(null)).toBe(UNAVAILABLE);
    expect(formatNumber(undefined)).toBe(UNAVAILABLE);
    expect(formatNumber(Number.NaN)).toBe(UNAVAILABLE);
    expect(formatMoney(null)).toBe(UNAVAILABLE);
    expect(formatPercent(null)).toBe(UNAVAILABLE);
  });

  it('keeps a real zero visible, because zero is data the provider supplied', () => {
    expect(formatNumber(0, 0)).toBe('0');
    expect(formatMoney(0)).toBe('$0');
    expect(formatPercent(0)).toBe('0%');
  });

  it('formats money, percent and precision the way the panel reads them', () => {
    expect(formatMoney(1234.567)).toBe('$1,234.57');
    expect(formatPercent(0.4271)).toBe('42.71%');
    expect(formatNumber(-0.523467, 4)).toBe('-0.5235');
  });
});

describe('moneyness', () => {
  const spot = 200;

  it('classifies calls and puts around spot', () => {
    expect(moneyness(contract({ type: 'call', strike: 190 }), spot)).toBe('ITM');
    expect(moneyness(contract({ type: 'call', strike: 210 }), spot)).toBe('OTM');
    expect(moneyness(contract({ type: 'put', strike: 210 }), spot)).toBe('ITM');
    expect(moneyness(contract({ type: 'put', strike: 190 }), spot)).toBe('OTM');
  });

  it('treats the tight band around spot as ATM for both sides', () => {
    expect(moneyness(contract({ type: 'call', strike: 200 }), spot)).toBe('ATM');
    expect(moneyness(contract({ type: 'put', strike: 200.4 }), spot)).toBe('ATM');
    expect(isAtmStrike(200.4, spot)).toBe(true);
    expect(isAtmStrike(201, spot)).toBe(false);
  });
});

describe('expected move framing', () => {
  it('marks only strikes outside a fully known band', () => {
    expect(isOutsideExpectedMove(180, { lower: 190, upper: 210 })).toBe(true);
    expect(isOutsideExpectedMove(220, { lower: 190, upper: 210 })).toBe(true);
    expect(isOutsideExpectedMove(200, { lower: 190, upper: 210 })).toBe(false);
  });

  it('never marks a strike when the provider IV could not produce a band', () => {
    expect(isOutsideExpectedMove(180, { lower: null, upper: 210 })).toBe(false);
    expect(isOutsideExpectedMove(180, { lower: 190, upper: null })).toBe(false);
    expect(isOutsideExpectedMove(180, null)).toBe(false);
    expect(isOutsideExpectedMove(180, undefined)).toBe(false);
  });
});

describe('buildStrikeRows', () => {
  const chain: OptionsChain = {
    underlyingSymbol: 'AAPL', spot: 200, expiration: EXPIRATION, expirations: [EXPIRATION],
    calls: [contract({ type: 'call', strike: 210 }), contract({ type: 'call', strike: 190 }), contract({ type: 'call', strike: 400 })],
    puts: [contract({ type: 'put', strike: 190 }), contract({ type: 'put', strike: 100 })],
    provider: 'alpaca', asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: null, completeness: 1, warnings: [],
  };

  it('pairs call and put on one row and sorts ascending by strike', () => {
    const rows = buildStrikeRows(chain, 20);
    expect(rows.map((row) => row.strike)).toEqual([190, 210]);
    expect(rows[0].call?.type).toBe('call');
    expect(rows[0].put?.type).toBe('put');
  });

  it('leaves a side null when the provider has no contract for it, instead of substituting one', () => {
    const rows = buildStrikeRows(chain, 20);
    expect(rows[1].strike).toBe(210);
    expect(rows[1].put).toBeNull();
  });

  it('drops strikes outside the selected range around spot', () => {
    expect(buildStrikeRows(chain, 4).map((row) => row.strike)).toEqual([]);
    // The range bound is inclusive: ±5% of 200 reaches exactly 190 and 210.
    expect(buildStrikeRows(chain, 5).map((row) => row.strike)).toEqual([190, 210]);
    expect(buildStrikeRows(chain, 60).map((row) => row.strike)).toEqual([100, 190, 210]);
  });
});

describe('contract metrics', () => {
  const spot = 200;

  it('shows every price field as unavailable when the provider quoted nothing', () => {
    const metrics = priceMetrics(contract({ type: 'call', strike: 200 }));
    expect(metrics.map((metric) => metric.key)).toEqual(['bid', 'ask', 'mid', 'last']);
    expect(metrics.every((metric) => metric.value === UNAVAILABLE)).toBe(true);
  });

  it('derives the midpoint only from a real two-sided quote', () => {
    const metrics = priceMetrics(contract({ type: 'call', strike: 200, bid: 4, ask: 4.4, last: 4.2 }));
    expect(metrics.find((metric) => metric.key === 'mid')?.value).toBe('4.2');
    const oneSided = priceMetrics(contract({ type: 'call', strike: 200, bid: null, ask: 4.4, last: 4.2 }));
    expect(oneSided.find((metric) => metric.key === 'mid')?.value).toBe(UNAVAILABLE);
    expect(oneSided.find((metric) => metric.key === 'last')?.value).toBe('4.2');
  });

  it('reports volume/OI/IV/intrinsic, distinguishing zero from unavailable', () => {
    const metrics = activityMetrics(contract({ type: 'call', strike: 190, volume: 0, openInterest: 1250, impliedVolatility: 0.3125 }), spot);
    expect(metrics.map((metric) => metric.value)).toEqual(['0', '1,250', '31.25%', '10']);
    const empty = activityMetrics(contract({ type: 'call', strike: 190 }), spot);
    expect(empty.map((metric) => metric.value)).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, '10']);
  });

  it('always emits three Greeks so a missing one renders as a dash', () => {
    const metrics = greekMetrics(contract({ type: 'call', strike: 200, delta: 0.5123, gamma: null, theta: -0.045 }));
    expect(metrics.map((metric) => `${metric.label} ${metric.value}`)).toEqual(['Δ 0.5123', `Γ ${UNAVAILABLE}`, 'Θ -0.045']);
    expect(hasAnyGreek(contract({ type: 'call', strike: 200 }))).toBe(false);
    expect(hasAnyGreek(contract({ type: 'call', strike: 200, vega: 0.12 }))).toBe(true);
  });
});

describe('computeVirtualWindow', () => {
  const empty = new Map<number, number>();

  it('returns an empty window for an empty chain', () => {
    expect(computeVirtualWindow({ count: 0, scrollTop: 0, viewportHeight: 400, overscan: 2, estimate: 100, heights: empty }))
      .toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  });

  it('windows uniform estimated rows with overscan on both edges', () => {
    const window = computeVirtualWindow({ count: 50, scrollTop: 500, viewportHeight: 400, overscan: 2, estimate: 100, heights: empty });
    expect(window.totalHeight).toBe(5_000);
    expect(window.start).toBe(3);
    expect(window.end).toBe(11);
    expect(window.padTop).toBe(300);
    expect(window.padBottom).toBe(5_000 - 1_100);
  });

  it('honours measured heights instead of forcing one constant row height', () => {
    const heights = new Map<number, number>([[0, 300], [1, 150]]);
    const window = computeVirtualWindow({ count: 4, scrollTop: 0, viewportHeight: 400, overscan: 0, estimate: 100, heights });
    expect(window.totalHeight).toBe(300 + 150 + 100 + 100);
    expect(window.start).toBe(0);
    expect(window.end).toBe(2);
    expect(window.padTop).toBe(0);
    expect(window.padBottom).toBe(200);
  });

  it('keeps at least one row rendered when scrolled to or past the end', () => {
    const window = computeVirtualWindow({ count: 10, scrollTop: 100_000, viewportHeight: 400, overscan: 0, estimate: 100, heights: empty });
    expect(window.end).toBeGreaterThan(window.start);
    expect(window.end).toBeLessThanOrEqual(10);
    expect(window.padTop + window.padBottom).toBeLessThanOrEqual(window.totalHeight);
  });

  it('never produces negative padding or a window past the row count', () => {
    for (const scrollTop of [-500, 0, 250, 999_999]) {
      const window = computeVirtualWindow({ count: 7, scrollTop, viewportHeight: 456, overscan: 3, estimate: 120, heights: empty });
      expect(window.padTop).toBeGreaterThanOrEqual(0);
      expect(window.padBottom).toBeGreaterThanOrEqual(0);
      expect(window.start).toBeGreaterThanOrEqual(0);
      expect(window.end).toBeLessThanOrEqual(7);
    }
  });

  it('falls back to the estimate for a nonsense measurement', () => {
    const heights = new Map<number, number>([[0, 0], [1, Number.NaN]]);
    const window = computeVirtualWindow({ count: 2, scrollTop: 0, viewportHeight: 400, overscan: 0, estimate: 120, heights });
    expect(window.totalHeight).toBe(240);
  });
});
