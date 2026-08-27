import { describe, expect, it } from 'vitest';
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type {
  MarketSignalResult,
  MarketSignalScoreComponent,
  MarketSignalState,
} from '@/src/lib/analytics/market-signal/types';
import { buildStockSummary } from './summary';

function component(normalizedScore: number | null): MarketSignalScoreComponent {
  return {
    points: normalizedScore === null ? null : Math.round(normalizedScore * 30),
    maxPoints: 30,
    normalizedScore,
    coverage: 1,
    factorsUsed: 3,
    available: normalizedScore !== null,
  };
}

function signal(
  nearestSupport: number | null,
  nearestResistance: number | null,
  {
    emaTrend = 0.8,
    momentum = 0.8,
    state = 'BULLISH' as MarketSignalState,
  }: { emaTrend?: number | null; momentum?: number | null; state?: MarketSignalState } = {},
): MarketSignalResult {
  return {
    symbol: 'AAPL',
    timeframe: '1D',
    calculatedAt: '2026-08-16T00:00:00.000Z',
    latestCandleAt: null,
    source: 'test',
    freshness: { status: 'delayed', asOf: null, maxAgeSeconds: null },
    dataPoints: { received: 300, finalized: 299 },
    scoreBreakdown: {
      emaTrend: component(emaTrend),
      momentum: component(momentum),
      trendStrength: component(0),
      volume: component(0),
      priceStructure: component(0),
    },
    reasons: [],
    warnings: [],
    flags: [],
    metrics: { nearestSupport, nearestResistance } as MarketSignalResult['metrics'],
    confidenceBreakdown: {} as MarketSignalResult['confidenceBreakdown'],
    status: 'available',
    state,
    bias: 'bullish',
    score: 60,
    confidence: 70,
    confidenceLabel: 'Medium',
    evidenceAgreement: 70,
    evidenceAgreementLabel: 'Medium',
  };
}

const earnings: EarningsSchedule = {
  status: 'available',
  symbol: 'AAPL',
  reportDate: '2026-08-28',
  timeOfDay: 'post-market',
  epsEstimate: null,
  daysToEarnings: 12,
  provider: 'alpha-vantage',
  asOf: '2026-08-16T00:00:00.000Z',
  stale: false,
};

const base = { price: 195, currency: 'USD' as string | null, earnings: null as EarningsSchedule | null };

describe('the level rows', () => {
  it('restates the canonical levels and report date, each pointing at an existing tab', () => {
    const { levels } = buildStockSummary({
      ...base,
      marketSignal: signal(185, 205),
      earnings,
    });

    expect(levels.map((item) => item.id)).toEqual(['support', 'resistance', 'earnings']);
    expect(levels[0]!.text).toContain('แนวรับใกล้ที่สุด $185.00');
    expect(levels[0]!.target).toBe('Chart');
    expect(levels[1]!.text).toContain('แนวต้านใกล้ที่สุด $205.00');
    expect(levels[2]!.text).toContain('อีก 12 วัน');
    expect(levels[2]!.target).toBe('Financials');
  });

  it('states the distance from the price the header is already showing', () => {
    const { levels } = buildStockSummary({ ...base, price: 200, marketSignal: signal(180, null) });
    expect(levels[0]!.text).toContain('ห่างจากราคาปัจจุบัน 10.0%');
  });

  it('omits a level that would be printed on the wrong side of the price', () => {
    const { levels } = buildStockSummary({ ...base, marketSignal: signal(210, 190) });
    expect(levels).toEqual([]);
  });
});

describe('the status rows', () => {
  /*
   * The engine clamps each component to −1…+1 and the cut points sit at ±0.4,
   * so these walk both boundaries from both sides. A rescaled score is the one
   * arithmetic step in this module, and an off-by-one in it would silently
   * re-label every stock page in the product.
   */
  it.each([
    [1, 'good', 'ขาขึ้น'],
    [0.4, 'good', 'ขาขึ้น'],
    [0.39, 'neutral', 'ทรงตัว'],
    [0, 'neutral', 'ทรงตัว'],
    [-0.39, 'weak', 'อ่อนแรง'],
    [-0.4, 'weak', 'อ่อนแรง'],
    [-0.41, 'bad', 'ขาลง'],
    [-1, 'bad', 'ขาลง'],
  ])('reads a trend component of %p as %s', (normalized, level, label) => {
    const { statuses } = buildStockSummary({ ...base, marketSignal: signal(null, null, { emaTrend: normalized }) });
    const trend = statuses.find((row) => row.id === 'trend')!;
    expect(trend.level).toBe(level);
    expect(trend.label).toBe(label);
  });

  it('gives แนวโน้ม and แรงส่ง their own words for the same level', () => {
    const { statuses } = buildStockSummary({
      ...base,
      marketSignal: signal(null, null, { emaTrend: 0.9, momentum: 0.9 }),
    });
    expect(statuses.map((row) => row.name)).toEqual(['แนวโน้ม', 'แรงส่ง']);
    expect(statuses[0]!.label).toBe('ขาขึ้น');
    // A trend "ขาขึ้น" and momentum "ขาขึ้น" would be one word doing two jobs.
    expect(statuses[1]!.label).toBe('แข็งแรง');
  });

  /*
   * A component the engine could not compute is DROPPED. Not "—", not "N/A",
   * and not ⚪: the row is a reading, and there is no reading to report.
   */
  it('drops a component the engine could not compute', () => {
    const { statuses } = buildStockSummary({
      ...base,
      marketSignal: signal(null, null, { emaTrend: null, momentum: 0.9 }),
    });
    expect(statuses.map((row) => row.id)).toEqual(['momentum']);
  });

  it('never prints a score, a placeholder or a locked row', () => {
    const { statuses } = buildStockSummary({ ...base, marketSignal: signal(185, 205) });
    for (const row of statuses) {
      expect(row.label).not.toMatch(/\d/);
      expect(row.label).not.toMatch(/—|N\/A|ล็อก|อัปเกรด/);
    }
  });

  /*
   * มูลค่าหุ้น and ความเสี่ยง were in the brief and are deliberately absent:
   * nothing in this product adjudicates either, so a row would be an invented
   * threshold printed as a measurement. งบการเงิน is the same case wearing a
   * real service — fundamentals publishes P/E and market cap, and no verdict.
   */
  it('has no row for a judgement no service makes', () => {
    const { statuses } = buildStockSummary({ ...base, marketSignal: signal(185, 205), earnings });
    expect(statuses.map((row) => row.name)).toEqual(['แนวโน้ม', 'แรงส่ง']);
    for (const row of statuses) {
      expect(row.name).not.toBe('มูลค่าหุ้น');
      expect(row.name).not.toBe('ความเสี่ยง');
      expect(row.name).not.toBe('งบการเงิน');
    }
  });

  it('shows a reader without the entitlement no rows at all', () => {
    const view = buildStockSummary({ ...base, marketSignal: null, earnings });
    expect(view.statuses).toEqual([]);
    // The earnings row does not depend on the signal, so it survives.
    expect(view.levels.map((item) => item.id)).toEqual(['earnings']);
  });
});

describe('the closing line', () => {
  it('names the direction, and the level the price is standing near', () => {
    // 205 is 2.5% above 195 — inside the 3% band.
    expect(buildStockSummary({ ...base, price: 200, marketSignal: signal(150, 205) }).closing)
      .toBe('ยังเป็นขาขึ้น แต่ราคาใกล้แนวต้าน');
    expect(buildStockSummary({ ...base, price: 200, marketSignal: signal(196, 400) }).closing)
      .toBe('ยังเป็นขาขึ้น และราคาใกล้แนวรับ');
  });

  it('says the direction alone when the price is not near either edge', () => {
    expect(buildStockSummary({ ...base, price: 200, marketSignal: signal(150, 400) }).closing)
      .toBe('ยังเป็นขาขึ้น');
  });

  it('reads the direction off the same table the card paints itself from', () => {
    const closingFor = (state: MarketSignalState) =>
      buildStockSummary({ ...base, price: 200, marketSignal: signal(null, null, { state }) }).closing;
    expect(closingFor('STRONG_BEARISH')).toBe('ยังเป็นขาลง');
    expect(closingFor('SIDEWAYS')).toBe('ยังไม่มีทิศทางชัดเจน');
    expect(closingFor('OVEREXTENDED')).toBe('แนวโน้มเริ่มอ่อนแรง');
  });

  /*
   * Only ONE clause is ever added. Price near both edges happens on a narrow
   * range, and "ใกล้แนวต้าน และใกล้แนวรับ" is a sentence that cancels itself out.
   */
  it('never names both edges at once', () => {
    const closing = buildStockSummary({ ...base, price: 200, marketSignal: signal(199, 201) }).closing!;
    expect(closing).toContain('แนวต้าน');
    expect(closing).not.toContain('แนวรับ');
  });

  it('is a sentence, never a paragraph, and never mentions how it was produced', () => {
    const closing = buildStockSummary({ ...base, price: 200, marketSignal: signal(150, 205) }).closing!;
    expect(closing.length).toBeLessThan(60);
    for (const banned of ['AI', 'ระบบประเมิน', 'จากการวิเคราะห์', 'มีความเป็นไปได้', '%']) {
      expect(closing).not.toContain(banned);
    }
  });

  it('has no line at all when there is no reading to open with', () => {
    expect(buildStockSummary({ ...base, marketSignal: null, earnings }).closing).toBeNull();
  });
});

describe('the whole view', () => {
  it('produces nothing at all when no canonical source answered', () => {
    expect(buildStockSummary({ ...base, marketSignal: null }))
      .toEqual({ statuses: [], levels: [], closing: null });
    expect(buildStockSummary({
      ...base,
      marketSignal: null,
      earnings: {
        status: 'unavailable',
        symbol: 'AAPL',
        reason: 'not-configured',
        message: 'ยังไม่ได้ตั้งค่าผู้ให้บริการปฏิทินงบการเงินบนเซิร์ฟเวอร์',
        provider: null,
        asOf: null,
      },
    })).toEqual({ statuses: [], levels: [], closing: null });
  });

  it('lets no null, undefined or NaN reach any string it builds', () => {
    const view = buildStockSummary({
      ...base,
      price: null,
      currency: null,
      marketSignal: signal(185, 205),
      earnings,
    });
    const text = [
      ...view.statuses.map((row) => `${row.name}${row.label}`),
      ...view.levels.map((item) => item.text),
      view.closing ?? '',
    ].join(' ');
    expect(text).not.toMatch(/undefined|null|NaN|Infinity/);
  });
});
