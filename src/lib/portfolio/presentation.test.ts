import { describe, expect, it } from 'vitest';
import { convertUsd, formatPortfolioMoney, signedMoney, signedPercent } from './presentation';

describe('portfolio currency presentation', () => {
  it('converts USD and THB using fixed-point normalization in both directions of display', () => {
    expect(convertUsd('1500', 'USD', '36.25')).toBe(1500);
    expect(convertUsd('1500', 'THB', '36.25')).toBe(54375);
    expect(formatPortfolioMoney('1500', 'USD', '36.25')).toContain('$1,500.00');
    expect(formatPortfolioMoney('1500', 'THB', '36.25')).toContain('฿54,375.00');
  });

  it('never falls back to 1:1 when an FX rate is unavailable', () => {
    expect(convertUsd(10, 'THB', null)).toBeNull();
    expect(formatPortfolioMoney(10, 'THB', null)).toBe('—');
  });

  it('uses one visibility flag for every balance and formats signs safely', () => {
    for (const amount of [1500, -50, 1450, 100]) expect(formatPortfolioMoney(amount, 'USD', null, false)).toBe('••••••');
    expect(signedMoney(125, 'USD', null)).toContain('+$125.00');
    expect(signedMoney(0, 'USD', null)).toContain('$0.00');
    expect(signedMoney(-125, 'USD', null)).toContain('-$125.00');
    expect(signedPercent(Number.NaN)).toBe('0.00%');
  });
});
