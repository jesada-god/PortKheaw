import { describe, expect, it } from 'vitest';
import { ALERT_UNIT, alertCountsBySymbol, describeCondition } from './logic';
import type { AlertCondition } from './types';

/*
  There is no `conditionMatches` test here any more, and its absence is the
  point. The comparison lives in `trigger_price_alert_service` — one evaluator,
  in SQL, in the same transaction that stamps the row — and the TypeScript copy
  that used to sit beside it was deleted with its only caller. A unit test over a
  second implementation of the matching would pass while the one that actually
  decides anything did something else, which is close to what happened when the
  product carried two alert systems.
*/

const CONDITIONS: AlertCondition[] = [
  'above', 'below', 'percent_change_up', 'percent_change_down', 'earnings',
];

describe('alert units', () => {
  it('gives every condition a unit', () => {
    for (const condition of CONDITIONS) expect(ALERT_UNIT[condition]).toBeTruthy();
  });

  it('measures earnings in days and nothing else does', () => {
    expect(ALERT_UNIT.earnings).toBe('days');
    expect(CONDITIONS.filter((condition) => ALERT_UNIT[condition] === 'days')).toEqual(['earnings']);
  });
});

describe('describeCondition', () => {
  it('states the reader threshold in the unit it was given in', () => {
    expect(describeCondition('above', 150)).toContain('150');
    expect(describeCondition('percent_change_up', 5)).toContain('5%');
    expect(describeCondition('percent_change_down', 5)).toContain('5%');
    expect(describeCondition('earnings', 7)).toBe('ประกาศผลประกอบการภายใน 7 วัน');
  });

  it('never describes an earnings alert as a price', () => {
    expect(describeCondition('earnings', 7)).not.toContain('ราคา');
  });

  it('answers for every condition', () => {
    for (const condition of CONDITIONS) expect(describeCondition(condition, 1)).not.toBe('');
  });
});

describe('alertCountsBySymbol', () => {
  const alert = (symbol: string, enabled = true) => ({ symbol, enabled });

  it('counts enabled alerts per symbol', () => {
    expect(alertCountsBySymbol([alert('NVDA'), alert('NVDA'), alert('AAPL')]))
      .toEqual({ NVDA: 2, AAPL: 1 });
  });

  it('leaves a symbol out entirely rather than reporting zero', () => {
    expect(alertCountsBySymbol([alert('NVDA', false)])).toEqual({});
  });

  it('keys on the upper-cased symbol so it joins with the quote map', () => {
    expect(alertCountsBySymbol([alert(' nvda ')])).toEqual({ NVDA: 1 });
  });

  it('is empty for no alerts', () => {
    expect(alertCountsBySymbol([])).toEqual({});
  });
});
