import { describe, expect, it } from 'vitest';
import { formatPrice } from './format';

describe('formatPrice', () => {
  it('uses two decimal places for compact headline prices', () => {
    expect(formatPrice(10.04, { mode: 'compact' })).toBe('10.04');
    expect(formatPrice(10.0458, { mode: 'compact' })).not.toContain('0458');
  });

  it('keeps a separate precision mode for indicators and tooltips', () => {
    expect(formatPrice(10.0458, { precision: 4 })).toBe('10.0458');
  });
});
