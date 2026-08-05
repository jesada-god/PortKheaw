import { describe, expect, it } from 'vitest';
import {
  bangkokDate, formatCount, formatMinorAsBaht, normalizeActivityKind, normalizeDashboardRange,
  resolveDashboardPeriod, resolvePagination, shiftDate, startOfMonth, totalPages,
} from './dashboard-presentation';

/**
 * The dashboard's date arithmetic, which is the thing most likely to be quietly
 * wrong on an operations screen: a window that means a different day than the
 * operator reading it thinks.
 */

describe('the Bangkok calendar', () => {
  it('is the operator’s day, not the server’s UTC day', () => {
    // 17:00 UTC is already tomorrow in Bangkok. A revenue figure read at 09:00
    // Bangkok must not still be showing yesterday.
    expect(bangkokDate(new Date('2026-08-04T17:00:00Z'))).toBe('2026-08-05');
    expect(bangkokDate(new Date('2026-08-04T16:59:59Z'))).toBe('2026-08-04');
  });

  it('shifts and truncates without a timezone in sight', () => {
    expect(shiftDate('2026-08-05', -1)).toBe('2026-08-04');
    expect(shiftDate('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(startOfMonth('2026-08-05')).toBe('2026-08-01');
  });
});

describe('the reporting window', () => {
  const now = new Date('2026-08-05T04:00:00Z'); // 11:00 Bangkok

  it('resolves each preset against the Bangkok day', () => {
    expect(resolveDashboardPeriod({ range: 'today', now })).toEqual({
      range: 'today', from: '2026-08-05', to: '2026-08-05',
    });
    expect(resolveDashboardPeriod({ range: '7d', now })).toEqual({
      range: '7d', from: '2026-07-30', to: '2026-08-05',
    });
    expect(resolveDashboardPeriod({ range: '30d', now })).toEqual({
      range: '30d', from: '2026-07-07', to: '2026-08-05',
    });
    expect(resolveDashboardPeriod({ range: 'month', now })).toEqual({
      range: 'month', from: '2026-08-01', to: '2026-08-05',
    });
  });

  it('includes today in the last seven days rather than the last eight', () => {
    const period = resolveDashboardPeriod({ range: '7d', now });
    const days = (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`))
      / 86_400_000 + 1;
    expect(days).toBe(7);
  });

  it('accepts a custom window and corrects a reversed one', () => {
    expect(resolveDashboardPeriod({ range: 'custom', from: '2026-08-01', to: '2026-08-03', now }))
      .toEqual({ range: 'custom', from: '2026-08-01', to: '2026-08-03' });
    expect(resolveDashboardPeriod({ range: 'custom', from: '2026-08-03', to: '2026-08-01', now }))
      .toEqual({ range: 'custom', from: '2026-08-01', to: '2026-08-03' });
  });

  it('falls back rather than refusing to render on a malformed query string', () => {
    for (const bad of [undefined, '', 'yesterday', '2026-13-45', '2026-8-5']) {
      const period = resolveDashboardPeriod({ range: 'custom', from: bad, to: '2026-08-05', now });
      expect(period.range).toBe('30d');
      expect(period.from).toBe('2026-07-07');
    }
  });

  it('falls back on an unrecognised range', () => {
    expect(normalizeDashboardRange('quarter')).toBe('30d');
    expect(normalizeDashboardRange(undefined)).toBe('30d');
    expect(resolveDashboardPeriod({ range: 'quarter', now }).range).toBe('30d');
  });
});

describe('money', () => {
  it('reads baht from the minor unit without a float', () => {
    expect(formatMinorAsBaht(39900)).toBe('399');
    expect(formatMinorAsBaht(799000)).toBe('7,990');
    expect(formatMinorAsBaht(0)).toBe('0');
  });

  it('shows a negative net honestly rather than as zero', () => {
    // Refunds can exceed collections inside a chosen window; hiding that would
    // make the figure a lie.
    expect(formatMinorAsBaht(-50000)).toBe('-500');
  });

  it('respects a zero-decimal currency', () => {
    expect(formatMinorAsBaht(1500, 'jpy')).toBe('1,500');
    expect(formatMinorAsBaht(1500, 'thb')).toBe('15');
  });

  it('answers a placeholder rather than NaN', () => {
    expect(formatMinorAsBaht(null)).toBe('—');
    expect(formatMinorAsBaht(undefined)).toBe('—');
    expect(formatMinorAsBaht(Number.NaN)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('filters and paging', () => {
  it('falls back on an unrecognised activity kind', () => {
    expect(normalizeActivityKind('payment')).toBe('payment');
    expect(normalizeActivityKind('everything')).toBe('all');
    expect(normalizeActivityKind(undefined)).toBe('all');
  });

  it('clamps a hand-edited page number', () => {
    expect(resolvePagination({ page: '3', pageSize: 20 })).toEqual({ page: 3, pageSize: 20, offset: 40 });
    expect(resolvePagination({ page: '0' }).page).toBe(1);
    expect(resolvePagination({ page: '-5' }).page).toBe(1);
    expect(resolvePagination({ page: 'abc' }).page).toBe(1);
    expect(resolvePagination({ page: '999999' }).page).toBe(1_000);
  });

  it('clamps the page size so a query string cannot ask for everything', () => {
    expect(resolvePagination({ pageSize: 5_000 }).pageSize).toBe(100);
    expect(resolvePagination({ pageSize: 0 }).pageSize).toBe(1);
  });

  it('always reports at least one page', () => {
    expect(totalPages(0, 20)).toBe(1);
    expect(totalPages(20, 20)).toBe(1);
    expect(totalPages(21, 20)).toBe(2);
  });
});
