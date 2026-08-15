import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HORIZON_PRESET,
  OUTLOOK_NOT_PROBABILITY_NOTICE,
  changeFromBaseline,
  daysBetween,
  evaluatePlanOutlook,
  formatRewardRisk,
  horizonDateForPreset,
  horizonRemainingLabel,
  planToday,
  savedPlanStatus,
} from './stock-plan-outlook';

/**
 * The Planner's arithmetic and its refusals.
 *
 * Two kinds of claim are tested here. The first is that the three numbers are the
 * three numbers — `(target − baseline) / baseline`, and so on — which is easy and
 * would be caught by anybody reading the screen. The second is the set of things
 * the module must REFUSE, which is where a planning tool actually hurts somebody:
 * an inverted plan computed into a positive-looking "upside", a division that
 * returns Infinity, a horizon in the past, a status that claims the price reached
 * a level nobody has evidence for.
 */

const TODAY = '2026-08-14';

/** A plan whose numbers are round enough to check by eye. */
function plan(overrides: Partial<Parameters<typeof evaluatePlanOutlook>[0]> = {}) {
  return evaluatePlanOutlook({
    baselinePrice: 100,
    targetPrice: 110,
    invalidationPrice: 96,
    horizonDate: '2026-11-14',
    today: TODAY,
    ...overrides,
  });
}

describe('what the three prices imply', () => {
  it('measures both distances from the baseline, and the ratio between them', () => {
    const { outlook, issues } = plan();
    expect(issues).toHaveLength(0);
    expect(outlook).not.toBeNull();
    expect(outlook!.upsidePercent).toBeCloseTo(10, 10);
    expect(outlook!.downsidePercent).toBeCloseTo(4, 10);
    expect(outlook!.rewardRisk).toBeCloseTo(2.5, 10);
  });

  it('reads the ratio with risk normalised to one', () => {
    expect(formatRewardRisk(2.5)).toBe('1 : 2.5');
    expect(formatRewardRisk(Number.POSITIVE_INFINITY)).toBe('ไม่มีข้อมูล');
  });

  it('states the three scenarios as the reader\'s own levels, in order', () => {
    const { scenarios } = plan();
    expect(scenarios!.map((scenario) => scenario.kind)).toEqual(['invalidation', 'flat', 'target']);
    expect(scenarios!.map((scenario) => scenario.label)).toEqual(['หลุดแผน', 'ทรงตัว', 'ถึงเป้าหมาย']);
    expect(scenarios!.map((scenario) => scenario.price)).toEqual([96, 100, 110]);
    expect(scenarios![0].changePercent).toBeCloseTo(-4, 10);
    expect(scenarios![1].changePercent).toBe(0);
    expect(scenarios![2].changePercent).toBeCloseTo(10, 10);
  });

  it('says in its own words that the distance is not a probability', () => {
    expect(OUTLOOK_NOT_PROBABILITY_NOTICE).toContain('ไม่ใช่ความน่าจะเป็น');
  });
});

describe('what it refuses', () => {
  it('refuses a target at or below the baseline, and computes nothing', () => {
    const { issues, outlook, scenarios } = plan({ targetPrice: 100 });
    expect(issues).toContainEqual({ field: 'target', message: 'ราคาเป้าหมายต้องสูงกว่าราคาปัจจุบัน' });
    expect(outlook).toBeNull();
    expect(scenarios).toBeNull();
  });

  it('refuses an invalidation level at or above the baseline', () => {
    const { issues, outlook } = plan({ invalidationPrice: 100 });
    expect(issues).toContainEqual({
      field: 'invalidation', message: 'ระดับที่แผนไม่เป็นไปตามคาดต้องต่ำกว่าราคาปัจจุบัน',
    });
    expect(outlook).toBeNull();
  });

  /*
    The inverted plan, which is the one that would actually mislead: without the
    ordering rules it computes a NEGATIVE upside and a NEGATIVE downside whose
    ratio is positive, so the result card would print a healthy-looking "1 : 2.5"
    over a plan that is upside down.
  */
  it('refuses an inverted plan rather than computing a plausible-looking ratio', () => {
    const { issues, outlook } = plan({ targetPrice: 90, invalidationPrice: 120 });
    expect(outlook).toBeNull();
    expect(issues.map((issue) => issue.field).sort()).toEqual(['invalidation', 'target']);
  });

  it('reports every problem at once rather than one per attempt', () => {
    const { issues } = plan({ targetPrice: null, invalidationPrice: null });
    expect(issues.map((issue) => issue.field).sort()).toEqual(['invalidation', 'target']);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['absurd', 5_000_000],
  ])('refuses a %s price and never divides by it', (_label, value) => {
    const { outlook } = plan({ baselinePrice: value });
    expect(outlook).toBeNull();
  });

  it('never returns a non-finite figure for any accepted plan', () => {
    // A one-cent risk on a large price is the closest a valid plan gets to a
    // division by zero; it must still be an ordinary number.
    const { outlook } = plan({ baselinePrice: 1000, targetPrice: 1000.01, invalidationPrice: 999.99 });
    expect(Number.isFinite(outlook!.rewardRisk)).toBe(true);
    expect(Number.isFinite(outlook!.upsidePercent)).toBe(true);
  });

  it.each([
    ['in the past', '2026-08-13'],
    ['today', TODAY],
  ])('refuses a horizon %s', (_label, horizonDate) => {
    const { issues } = plan({ horizonDate });
    expect(issues).toContainEqual({ field: 'horizon', message: 'ระยะเวลาของแผนต้องเป็นวันในอนาคต' });
  });

  it('refuses a malformed horizon', () => {
    expect(plan({ horizonDate: '14/11/2026' }).issues)
      .toContainEqual({ field: 'horizon', message: 'รูปแบบวันที่ไม่ถูกต้อง' });
  });
});

describe('the horizon', () => {
  it('defaults to three months', () => {
    expect(DEFAULT_HORIZON_PRESET).toBe('3m');
  });

  it.each([
    ['1m', '2026-09-14'],
    ['3m', '2026-11-14'],
    ['6m', '2027-02-14'],
    ['1y', '2027-08-14'],
  ] as const)('resolves %s from today', (preset, expected) => {
    expect(horizonDateForPreset(preset, TODAY)).toBe(expected);
  });

  /*
    "One month from the 31st" has no 31st to land on. The platform's own
    `setMonth` rolls it into the following month, which would quietly move a
    one-month plan to 3 March.
  */
  it('clamps to the last real day of the target month', () => {
    expect(horizonDateForPreset('1m', '2026-01-31')).toBe('2026-02-28');
    expect(horizonDateForPreset('1m', '2028-01-31')).toBe('2028-02-29');
    expect(horizonDateForPreset('3m', '2026-05-31')).toBe('2026-08-31');
  });

  it('crosses a year boundary correctly', () => {
    expect(horizonDateForPreset('6m', '2026-10-15')).toBe('2027-04-15');
  });

  it('has no date of its own for a custom horizon', () => {
    expect(horizonDateForPreset('custom', TODAY)).toBeNull();
  });

  it('counts whole days, and never counts down past zero in words', () => {
    expect(daysBetween(TODAY, '2026-11-14')).toBe(92);
    expect(horizonRemainingLabel('2026-11-14', TODAY)).toBe('เหลืออีก 92 วัน');
    expect(horizonRemainingLabel('2026-08-15', TODAY)).toBe('เหลืออีก 1 วัน');
    expect(horizonRemainingLabel('2026-08-01', TODAY)).toBe('ครบระยะเวลาแล้ว');
  });

  it('reads today in the exchange\'s zone, not the reader\'s', () => {
    // 03:00 UTC on the 15th is still the 14th in New York.
    expect(planToday(new Date('2026-08-15T03:00:00Z'))).toBe('2026-08-14');
  });
});

describe('what a saved plan can be said to be', () => {
  const base = { targetPrice: 120, invalidationPrice: 90, horizonDate: '2026-12-31', today: TODAY };

  it('is tracking while the price sits between the levels', () => {
    expect(savedPlanStatus({ ...base, currentPrice: 105 })).toBe('tracking');
  });

  it('reports reaching the target only about the present', () => {
    expect(savedPlanStatus({ ...base, currentPrice: 125 })).toBe('at-target');
    expect(savedPlanStatus({ ...base, currentPrice: 120 })).toBe('at-target');
  });

  it('reports falling below the plan level only about the present', () => {
    expect(savedPlanStatus({ ...base, currentPrice: 85 })).toBe('below-invalidation');
  });

  /*
    A plan past its date has run its course whatever the price is doing. Calling
    it "ถึงระดับเป้าหมาย" today would describe a plan that is over.
  */
  it('calls an expired plan expired, whatever the price is doing', () => {
    expect(savedPlanStatus({ ...base, horizonDate: '2026-08-01', currentPrice: 200 })).toBe('expired');
    expect(savedPlanStatus({ ...base, horizonDate: '2026-08-01', currentPrice: 10 })).toBe('expired');
  });

  it('claims nothing at all without a price', () => {
    expect(savedPlanStatus({ ...base, currentPrice: null })).toBe('tracking');
    expect(savedPlanStatus({ ...base, currentPrice: 0 })).toBe('tracking');
  });

  it('measures drift from the plan\'s own baseline, and omits it without a price', () => {
    expect(changeFromBaseline(100, 110)).toBeCloseTo(10, 10);
    expect(changeFromBaseline(100, 90)).toBeCloseTo(-10, 10);
    expect(changeFromBaseline(100, null)).toBeNull();
    expect(changeFromBaseline(0, 110)).toBeNull();
  });
});
