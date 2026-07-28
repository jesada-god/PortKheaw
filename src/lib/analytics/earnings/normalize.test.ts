import { describe, expect, it } from 'vitest';
import {
  alphaVantageNotice,
  calendarDaysUntil,
  nextEarnings,
  parseAlphaVantageEarningsCsv,
  parseFinancialModelingPrepEarnings,
  splitCsvLine,
} from './normalize';

describe('splitCsvLine', () => {
  it('keeps commas that belong to a quoted company name', () => {
    expect(splitCsvLine('AAPL,"APPLE, INC.",2026-07-30')).toEqual(['AAPL', 'APPLE, INC.', '2026-07-30']);
    expect(splitCsvLine('A,"say ""hi""",B')).toEqual(['A', 'say "hi"', 'B']);
  });
});

describe('parseAlphaVantageEarningsCsv', () => {
  // The exact shape returned by a live EARNINGS_CALENDAR probe on 2026-07-28.
  const body = [
    'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
    'AAPL,APPLE INCORPORATED,2026-07-30,2026-06-30,1.88,USD,post-market',
    'AAPL,APPLE INCORPORATED,2026-10-29,2026-09-30,,USD,pre-market',
  ].join('\n');

  it('parses the real provider CSV and dates the session', () => {
    const rows = parseAlphaVantageEarningsCsv(body, 'aapl');
    expect(rows).toEqual([
      { symbol: 'AAPL', reportDate: '2026-07-30', timeOfDay: 'post-market', epsEstimate: 1.88 },
      { symbol: 'AAPL', reportDate: '2026-10-29', timeOfDay: 'pre-market', epsEstimate: null },
    ]);
  });

  it('drops rows for another symbol and never guesses a missing estimate', () => {
    const mixed = `${body}\nMSFT,MICROSOFT,2026-07-29,2026-06-30,3.10,USD,post-market`;
    expect(parseAlphaVantageEarningsCsv(mixed, 'MSFT')).toHaveLength(1);
  });

  it('returns nothing for a JSON note, so the caller can fall through', () => {
    expect(parseAlphaVantageEarningsCsv('{"Information":"premium endpoint"}', 'AAPL')).toEqual([]);
    expect(parseAlphaVantageEarningsCsv('', 'AAPL')).toEqual([]);
  });
});

describe('alphaVantageNotice', () => {
  // Verbatim body from a live quota-exhausted EARNINGS_CALENDAR response.
  const quotaBody = 'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\r\nI,n,f,o,r,m,a\r\n';

  it('detects the character-per-field notice AV disguises as a CSV row', () => {
    expect(alphaVantageNotice(quotaBody)).toBe('Informa');
    // The mislabel this guards against: it would otherwise parse as zero rows.
    expect(parseAlphaVantageEarningsCsv(quotaBody, 'AAPL')).toEqual([]);
  });

  it('does not mistake a real earnings row for a notice', () => {
    const realBody = [
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
      'AAPL,APPLE INCORPORATED,2026-07-30,2026-06-30,1.88,USD,post-market',
    ].join('\n');
    expect(alphaVantageNotice(realBody)).toBeNull();
    expect(alphaVantageNotice('')).toBeNull();
  });
});

describe('parseFinancialModelingPrepEarnings', () => {
  // The exact shape returned by a live stable/earnings probe on 2026-07-28.
  const payload = [
    { symbol: 'AAPL', date: '2026-07-30', epsActual: null, epsEstimated: 1.88, revenueActual: null },
    { symbol: 'AAPL', date: '2026-04-30', epsActual: 2.01, epsEstimated: 1.95 },
    { symbol: 'HCA', date: '2026-07-24', epsActual: 7.59, epsEstimated: 7.56 },
  ];

  it('parses the real provider rows for the requested symbol only', () => {
    expect(parseFinancialModelingPrepEarnings(payload, 'AAPL')).toEqual([
      { symbol: 'AAPL', reportDate: '2026-07-30', timeOfDay: 'unknown', epsEstimate: 1.88 },
      { symbol: 'AAPL', reportDate: '2026-04-30', timeOfDay: 'unknown', epsEstimate: 1.95 },
    ]);
  });

  it('rejects a non-array plan/quota payload', () => {
    expect(parseFinancialModelingPrepEarnings({ 'Error Message': 'no access' }, 'AAPL')).toEqual([]);
  });
});

describe('calendarDaysUntil', () => {
  it('counts whole calendar days and rejects malformed dates', () => {
    expect(calendarDaysUntil('2026-07-28', '2026-07-30')).toBe(2);
    expect(calendarDaysUntil('2026-07-28', '2026-07-28')).toBe(0);
    expect(calendarDaysUntil('2026-07-28', '2026-07-27')).toBe(-1);
    expect(calendarDaysUntil('not-a-date', '2026-07-30')).toBeNull();
  });
});

describe('nextEarnings', () => {
  const rows = [
    { symbol: 'AAPL', reportDate: '2026-04-30', timeOfDay: 'unknown' as const, epsEstimate: 1.95 },
    { symbol: 'AAPL', reportDate: '2026-10-29', timeOfDay: 'pre-market' as const, epsEstimate: null },
    { symbol: 'AAPL', reportDate: '2026-07-30', timeOfDay: 'post-market' as const, epsEstimate: 1.88 },
  ];

  it('selects the soonest report that has not happened yet', () => {
    expect(nextEarnings(rows, '2026-07-28')).toMatchObject({ reportDate: '2026-07-30', daysToEarnings: 2 });
  });

  it('treats a report dated today as zero days away, not as history', () => {
    expect(nextEarnings(rows, '2026-07-30')).toMatchObject({ reportDate: '2026-07-30', daysToEarnings: 0 });
  });

  it('returns null when every row is in the past', () => {
    expect(nextEarnings(rows, '2026-11-01')).toBeNull();
    expect(nextEarnings([], '2026-07-28')).toBeNull();
  });
});
