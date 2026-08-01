import { describe, expect, it } from 'vitest';
import { conditionMatches, cooldownElapsed, shouldTriggerCrossing } from './logic';

const quote = { price: 100, changePercent: 4.5 };
describe('price alert conditions', () => {
  it('matches above and below inclusively at the boundary', () => {
    expect(conditionMatches({ condition: 'above', targetValue: 100 }, quote)).toBe(true);
    expect(conditionMatches({ condition: 'above', targetValue: 101 }, quote)).toBe(false);
    expect(conditionMatches({ condition: 'below', targetValue: 100 }, quote)).toBe(true);
    expect(conditionMatches({ condition: 'below', targetValue: 99 }, quote)).toBe(false);
  });
  it('matches signed percent movement from a positive threshold', () => {
    expect(conditionMatches({ condition: 'percent_change_up', targetValue: 4.5 }, quote)).toBe(true);
    expect(conditionMatches({ condition: 'percent_change_down', targetValue: 4.5 }, { price: 100, changePercent: -4.5 })).toBe(true);
    expect(conditionMatches({ condition: 'percent_change_down', targetValue: 4.5 }, quote)).toBe(false);
    expect(conditionMatches({ condition: 'percent_change_up', targetValue: 1 }, { price: 100, changePercent: null })).toBe(false);
  });
  it('rejects invalid thresholds', () => expect(conditionMatches({ condition: 'above', targetValue: 0 }, quote)).toBe(false));
});

describe('price alert cooldown', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  it('allows the first trigger and a trigger exactly at cooldown expiry', () => {
    expect(cooldownElapsed(null, 60, now)).toBe(true);
    expect(cooldownElapsed('2026-07-18T11:00:00.000Z', 60, now)).toBe(true);
  });
  it('blocks repeated triggers inside cooldown', () => expect(cooldownElapsed('2026-07-18T11:00:01.000Z', 60, now)).toBe(false));
});

describe('price alert crossing state', () => {
  it('triggers only when entering the target zone', () => {
    expect(shouldTriggerCrossing(false, true)).toBe(true);
    expect(shouldTriggerCrossing(true, true)).toBe(false);
  });

  it('re-arms after leaving the target zone', () => {
    expect(shouldTriggerCrossing(true, false)).toBe(false);
    expect(shouldTriggerCrossing(false, true)).toBe(true);
  });
});

