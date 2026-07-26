import { describe, expect, it } from 'vitest';
import { normalizeImpliedVolatility, normalizeOptionContracts } from './normalize';

const context = {
  provider: 'test-provider',
  asOf: '2026-07-20T14:00:00.000Z',
  timestampKind: 'provider' as const,
  status: 'live' as const,
  delayedMinutes: 0,
  ivUnit: 'decimal' as const,
  defaultMultiplier: 100,
  defaultCurrency: 'USD',
};

const row = (overrides: Record<string, unknown> = {}) => ({
  contractSymbol: 'RKLB260821C00050000', underlyingSymbol: 'RKLB', type: 'call',
  expiration: '2026-08-21', strike: '50', bid: '0', ask: '1.20', last: '', mark: null,
  volume: '0', openInterest: undefined, impliedVolatility: '0.35',
  ...overrides,
});

describe('normalized options contracts', () => {
  it('preserves real zero values while representing missing fields as null', () => {
    const result = normalizeOptionContracts([row()], context);
    expect(result.contracts[0]).toMatchObject({
      bid: 0,
      last: null,
      mark: null,
      volume: 0,
      openInterest: null,
      impliedVolatility: 0.35,
      timestampKind: 'provider',
    });
  });

  it('deduplicates contract identity and keeps the more complete snapshot', () => {
    const result = normalizeOptionContracts([
      row({ bid: null, ask: null }),
      row({ bid: '1.00', ask: '1.20', openInterest: '42' }),
    ], context);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toMatchObject({ bid: 1, ask: 1.2, openInterest: 42 });
    expect(result.warnings.join(' ')).toMatch(/deduplicated/i);
  });

  it('isolates requested expiration and warns about crossed snapshots', () => {
    const result = normalizeOptionContracts([
      row({ asOf: '2026-07-20T14:00:00.000Z' }),
      row({ contractSymbol: 'RKLB260918C00050000', expiration: '2026-09-18', asOf: '2026-07-20T14:01:00.000Z' }),
    ], { ...context, expiration: '2026-08-21' });
    expect(result.expirations).toEqual(['2026-08-21']);
    expect(result.warnings.join(' ')).toMatch(/outside the requested expiration/i);
  });

  it('normalizes percent IV exactly once and leaves provider decimals unchanged', () => {
    expect(normalizeImpliedVolatility(35, 'percent')).toBe(0.35);
    expect(normalizeImpliedVolatility(0.35, 'decimal')).toBe(0.35);
    expect(normalizeImpliedVolatility(35, 'auto')).toBe(0.35);
  });

  it('excludes crossed bid/ask values without replacing them with zero', () => {
    const result = normalizeOptionContracts([row({ bid: '2', ask: '1' })], context);
    expect(result.contracts[0]).toMatchObject({ bid: null, ask: null });
    expect(result.warnings.join(' ')).toMatch(/crossed bid\/ask/i);
  });
});
