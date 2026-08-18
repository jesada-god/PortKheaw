import { describe, expect, it } from 'vitest';
import { atmImpliedVolatility, chooseExpiration, deriveExpectedMove, MINIMUM_DAYS_TO_EXPIRY } from './derive';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';

/**
 * The collector's rules, tested where they are decided.
 *
 * This table will be written to every day for years before anybody reads it, so
 * a wrong rule here is a wrong rule that goes unnoticed for a very long time and
 * cannot be repaired afterwards — the chain it was derived from is gone. That is
 * the reason a four-number collector has a test file at all.
 */

type Contract = OptionsChain['calls'][number];
const contract = (strike: number, iv: number | null): Contract => ({
  strike, impliedVolatility: iv,
} as Contract);

const chain = (over: Partial<Pick<OptionsChain, 'spot' | 'expiration' | 'calls' | 'puts'>> = {}) => ({
  underlyingSymbol: 'AAPL',
  provider: 'alpaca',
  spot: 100,
  expiration: '2026-09-18',
  calls: [contract(95, 0.30), contract(100, 0.20), contract(105, 0.34)],
  puts: [contract(95, 0.33), contract(100, 0.24), contract(105, 0.31)],
  ...over,
});

describe('chooseExpiration', () => {
  /*
   * The rule that makes the series comparable with itself. A chain carries
   * weeklies and monthlies together, so "the nearest expiry" is one day out on
   * a Thursday and thirty on the Monday after — and a series whose horizon
   * jumps around cannot be fixed by any later normalisation.
   */
  it('skips expiries too close to be an expected move', () => {
    const chosen = chooseExpiration(['2026-08-19', '2026-08-21', '2026-09-18'], '2026-08-18');
    expect(chosen).toBe('2026-09-18');
  });

  it('takes the nearest of those that qualify', () => {
    const chosen = chooseExpiration(['2026-10-16', '2026-08-25', '2026-09-18'], '2026-08-18');
    expect(chosen).toBe('2026-08-25');
  });

  it('accepts one exactly at the threshold', () => {
    const asOf = '2026-08-18';
    const boundary = new Date(Date.parse(`${asOf}T00:00:00Z`) + MINIMUM_DAYS_TO_EXPIRY * 86_400_000)
      .toISOString().slice(0, 10);
    expect(chooseExpiration([boundary], asOf)).toBe(boundary);
  });

  it('has nothing to say when every expiry is too close', () => {
    expect(chooseExpiration(['2026-08-19', '2026-08-20'], '2026-08-18')).toBeNull();
  });
});

describe('atmImpliedVolatility', () => {
  it('averages the call and the put at the strike nearest spot', () => {
    const atm = atmImpliedVolatility(chain())!;
    expect(atm.strike).toBe(100);
    expect(atm.iv).toBeCloseTo(0.22, 10);
  });

  it('picks the nearest strike even when nothing sits exactly at spot', () => {
    const atm = atmImpliedVolatility(chain({ spot: 103.4 }))!;
    expect(atm.strike).toBe(105);
  });

  it('uses whichever side quotes when only one does', () => {
    const atm = atmImpliedVolatility(chain({
      calls: [contract(100, 0.40)],
      puts: [contract(100, null)],
    }))!;
    expect(atm.iv).toBeCloseTo(0.40, 10);
  });

  /*
   * A zero would be a lie that later reads as an extraordinarily calm market,
   * which is the worst possible failure for a series nobody checks for a year.
   */
  it('refuses rather than inventing a volatility', () => {
    expect(atmImpliedVolatility(chain({
      calls: [contract(100, null)],
      puts: [contract(100, 0)],
    }))).toBeNull();
    expect(atmImpliedVolatility(chain({ calls: [], puts: [] }))).toBeNull();
  });
});

describe('deriveExpectedMove', () => {
  it('computes the move as spot · iv · sqrt(days/365)', () => {
    const observation = deriveExpectedMove(chain({ expiration: '2026-09-18' }), '2026-08-18')!;
    expect(observation.daysToExpiry).toBe(31);
    const expected = 100 * 0.22 * Math.sqrt(31 / 365);
    expect(observation.impliedMove).toBeCloseTo(expected, 10);
  });

  /*
   * The percentage is the one that survives a split. An absolute move recorded
   * before a 4-for-1 is not comparable with one recorded after it, and this
   * series is meant to be read years later.
   */
  it('stores the move as a share of spot as well as in price units', () => {
    const observation = deriveExpectedMove(chain(), '2026-08-18')!;
    expect(observation.impliedMovePct).toBeCloseTo(observation.impliedMove / observation.spot, 12);
  });

  it('records the strike it read, so the ATM choice can be audited later', () => {
    expect(deriveExpectedMove(chain({ spot: 103.4 }), '2026-08-18')!.atmStrike).toBe(105);
  });

  it('carries the provider, so a break in the series is attributable', () => {
    expect(deriveExpectedMove(chain(), '2026-08-18')!.provider).toBe('alpaca');
  });

  describe('writes nothing rather than something invented', () => {
    it('when the chosen expiry turns out to be too close after all', () => {
      expect(deriveExpectedMove(chain({ expiration: '2026-08-20' }), '2026-08-18')).toBeNull();
    });

    it('when no implied volatility is quoted at the money', () => {
      expect(deriveExpectedMove(chain({
        calls: [contract(100, null)],
        puts: [contract(100, null)],
      }), '2026-08-18')).toBeNull();
    });

    it('when the underlying has no usable price', () => {
      expect(deriveExpectedMove(chain({ spot: 0 }), '2026-08-18')).toBeNull();
    });
  });
});
