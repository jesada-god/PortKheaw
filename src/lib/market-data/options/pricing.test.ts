import { describe, expect, it } from 'vitest';
import {
  black76Greeks,
  black76Price,
  normalCdf,
  optionExpiryInstantMs,
  solveForwardCurve,
  solveImpliedVolatility,
  yearsToExpiry,
} from './pricing';

describe('normalCdf', () => {
  // The Abramowitz-Stegun 7.1.26 kernel is accurate to ~1.5e-7 absolute, which
  // is the tolerance asserted here — orders of magnitude finer than any quote.
  it('matches known standard-normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
  });

  it('is symmetric about zero', () => {
    for (const x of [0.25, 0.75, 1.5, 2.5]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 9);
    }
  });
});

describe('solveForwardCurve', () => {
  it('recovers the discount factor and forward that generated the parity prices', () => {
    // Construct C - P = DF * (F - K) exactly for a known DF/F.
    const discountFactor = 0.99;
    const forward = 210;
    const observations = [190, 200, 210, 220].map((strike) => ({
      strike,
      // Any positive split works; only the difference carries parity information.
      callPrice: 40 + discountFactor * (forward - strike),
      putPrice: 40,
    }));

    const curve = solveForwardCurve(observations, 0.25);

    expect(curve).not.toBeNull();
    expect(curve!.discountFactor).toBeCloseTo(discountFactor, 9);
    expect(curve!.forward).toBeCloseTo(forward, 7);
  });

  it('returns null without at least two distinct strikes', () => {
    expect(solveForwardCurve([{ strike: 200, callPrice: 10, putPrice: 8 }], 0.25)).toBeNull();
    expect(solveForwardCurve([
      { strike: 200, callPrice: 10, putPrice: 8 },
      { strike: 200, callPrice: 11, putPrice: 9 },
    ], 0.25)).toBeNull();
  });

  it('ignores rows without a real two-sided pair', () => {
    const observations = [
      { strike: 100, callPrice: 0, putPrice: 5 },
      { strike: 110, callPrice: 6, putPrice: 0 },
      { strike: 120, callPrice: 4, putPrice: 9 },
    ];
    // Only one usable row survives, so there is nothing to fit.
    expect(solveForwardCurve(observations, 0.5)).toBeNull();
  });

  it('rejects an economically impossible fit instead of guessing a rate', () => {
    // An increasing C - P in K implies a negative discount factor.
    const observations = [
      { strike: 100, callPrice: 5, putPrice: 5 },
      { strike: 110, callPrice: 15, putPrice: 5 },
    ];
    expect(solveForwardCurve(observations, 0.25)).toBeNull();
  });

  it('returns null for a non-positive time to expiry', () => {
    const observations = [
      { strike: 100, callPrice: 12, putPrice: 2 },
      { strike: 110, callPrice: 3, putPrice: 13 },
    ];
    expect(solveForwardCurve(observations, 0)).toBeNull();
  });
});

describe('black76Price', () => {
  it('prices an at-the-forward option with the closed-form approximation', () => {
    // At F = K the Black-76 price reduces to DF*F*(2*N(sigma*sqrt(T)/2) - 1).
    const forward = 100;
    const volatility = 0.2;
    const timeToExpiryYears = 1;
    const discountFactor = 1;
    const expected = discountFactor * forward * (2 * normalCdf(volatility * Math.sqrt(timeToExpiryYears) / 2) - 1);

    const price = black76Price({ type: 'call', strike: forward, timeToExpiryYears, discountFactor, forward, volatility });

    expect(price).not.toBeNull();
    expect(price!).toBeCloseTo(expected, 6);
  });

  it('satisfies put-call parity', () => {
    const shared = { strike: 95, timeToExpiryYears: 0.5, discountFactor: 0.98, forward: 100, volatility: 0.3 };
    const call = black76Price({ ...shared, type: 'call' })!;
    const put = black76Price({ ...shared, type: 'put' })!;
    expect(call - put).toBeCloseTo(shared.discountFactor * (shared.forward - shared.strike), 8);
  });

  it('returns null on invalid inputs rather than a number', () => {
    const base = { strike: 100, timeToExpiryYears: 0.5, discountFactor: 0.99, forward: 100, volatility: 0.2 } as const;
    expect(black76Price({ ...base, type: 'call', volatility: 0 })).toBeNull();
    expect(black76Price({ ...base, type: 'call', timeToExpiryYears: 0 })).toBeNull();
    expect(black76Price({ ...base, type: 'call', forward: 0 })).toBeNull();
    expect(black76Price({ ...base, type: 'call', strike: -1 })).toBeNull();
  });
});

describe('solveImpliedVolatility', () => {
  it('round-trips a known volatility from its own model price', () => {
    for (const volatility of [0.12, 0.25, 0.4, 0.85, 1.6]) {
      for (const type of ['call', 'put'] as const) {
        const shared = { type, strike: 205, spot: 200, timeToExpiryYears: 0.08, discountFactor: 0.997, forward: 201 };
        const optionPrice = black76Price({ ...shared, volatility })!;
        const solved = solveImpliedVolatility({ ...shared, optionPrice });
        expect(solved).not.toBeNull();
        expect(solved!).toBeCloseTo(volatility, 5);
      }
    }
  });

  it('returns null for a price at or below intrinsic value', () => {
    const shared = {
      type: 'call' as const, strike: 100, spot: 120, timeToExpiryYears: 0.25,
      discountFactor: 1, forward: 120,
    };
    expect(solveImpliedVolatility({ ...shared, optionPrice: 20 })).toBeNull();
    expect(solveImpliedVolatility({ ...shared, optionPrice: 19 })).toBeNull();
  });

  it('returns null for a price above the no-arbitrage upper bound', () => {
    expect(solveImpliedVolatility({
      type: 'call', strike: 100, spot: 100, timeToExpiryYears: 0.25,
      discountFactor: 1, forward: 100, optionPrice: 101,
    })).toBeNull();
  });

  it('returns null when the volatility would exceed the solvable bracket', () => {
    const shared = { type: 'call' as const, strike: 100, spot: 100, timeToExpiryYears: 1, discountFactor: 1, forward: 100 };
    // Priced at a volatility beyond the 500% clamp, so the answer would be the clamp.
    const optionPrice = black76Price({ ...shared, volatility: 6 })!;
    expect(solveImpliedVolatility({ ...shared, optionPrice })).toBeNull();
  });

  it('returns null on missing or non-positive inputs', () => {
    const base = {
      type: 'call' as const, strike: 100, spot: 100, timeToExpiryYears: 0.25,
      discountFactor: 0.99, forward: 100, optionPrice: 5,
    };
    expect(solveImpliedVolatility({ ...base, optionPrice: 0 })).toBeNull();
    expect(solveImpliedVolatility({ ...base, timeToExpiryYears: 0 })).toBeNull();
    expect(solveImpliedVolatility({ ...base, forward: 0 })).toBeNull();
    expect(solveImpliedVolatility({ ...base, discountFactor: 0 })).toBeNull();
    expect(solveImpliedVolatility({ ...base, optionPrice: Number.NaN })).toBeNull();
  });
});

describe('black76Greeks', () => {
  it('produces the textbook at-the-forward call delta of about 0.5', () => {
    const greeks = black76Greeks({
      type: 'call', strike: 100, spot: 100, timeToExpiryYears: 0.01,
      discountFactor: 1, forward: 100, volatility: 0.2,
    });
    expect(greeks).not.toBeNull();
    expect(greeks!.delta).toBeCloseTo(0.5, 2);
  });

  it('keeps call and put delta separated by one, and shares gamma and vega', () => {
    const shared = {
      strike: 210, spot: 200, timeToExpiryYears: 0.25,
      discountFactor: 1, forward: 200, volatility: 0.35,
    };
    const call = black76Greeks({ ...shared, type: 'call' })!;
    const put = black76Greeks({ ...shared, type: 'put' })!;
    expect(call.delta - put.delta).toBeCloseTo(1, 6);
    expect(call.gamma).toBeCloseTo(put.gamma, 10);
    expect(call.vega).toBeCloseTo(put.vega, 10);
  });

  it('signs delta, gamma and theta the way a long option behaves', () => {
    const shared = { strike: 200, spot: 200, timeToExpiryYears: 0.25, discountFactor: 1, forward: 200, volatility: 0.3 };
    const call = black76Greeks({ ...shared, type: 'call' })!;
    const put = black76Greeks({ ...shared, type: 'put' })!;
    expect(call.delta).toBeGreaterThan(0);
    expect(put.delta).toBeLessThan(0);
    expect(call.gamma).toBeGreaterThan(0);
    expect(put.gamma).toBeGreaterThan(0);
    expect(call.theta).toBeLessThan(0);
    expect(put.theta).toBeLessThan(0);
    expect(call.vega).toBeGreaterThan(0);
  });

  it('matches a finite-difference delta computed from the model price', () => {
    const spot = 200;
    const forward = 202;
    const shared = { type: 'call' as const, strike: 205, timeToExpiryYears: 0.3, discountFactor: 0.995, volatility: 0.28 };
    // A 1.0 step keeps the differencing well above the erf kernel's ~1e-7 noise
    // floor; a smaller step would measure that approximation, not the analytic
    // derivative.
    const step = 1;
    // Forward scales with spot, so bump both consistently.
    const up = black76Price({ ...shared, forward: forward * (spot + step) / spot })!;
    const down = black76Price({ ...shared, forward: forward * (spot - step) / spot })!;
    const numeric = (up - down) / (2 * step);

    const greeks = black76Greeks({ ...shared, spot, forward })!;

    expect(greeks.delta).toBeCloseTo(numeric, 4);
  });

  it('returns null on invalid inputs', () => {
    const base = {
      type: 'call' as const, strike: 100, spot: 100, timeToExpiryYears: 0.25,
      discountFactor: 0.99, forward: 100, volatility: 0.2,
    };
    expect(black76Greeks({ ...base, volatility: 0 })).toBeNull();
    expect(black76Greeks({ ...base, spot: 0 })).toBeNull();
    expect(black76Greeks({ ...base, timeToExpiryYears: -1 })).toBeNull();
  });
});

describe('yearsToExpiry', () => {
  it('computes an ACT/365 year fraction', () => {
    const start = Date.UTC(2026, 0, 1);
    expect(yearsToExpiry(start, start + 365 * 24 * 60 * 60 * 1_000)).toBeCloseTo(1, 12);
    expect(yearsToExpiry(start, start + 73 * 24 * 60 * 60 * 1_000)).toBeCloseTo(0.2, 12);
  });

  it('returns null for an expiry that is not in the future', () => {
    const start = Date.UTC(2026, 0, 1);
    expect(yearsToExpiry(start, start)).toBeNull();
    expect(yearsToExpiry(start, start - 1)).toBeNull();
    expect(yearsToExpiry(Number.NaN, start)).toBeNull();
  });
});

describe('optionExpiryInstantMs', () => {
  it('resolves 16:00 New York during daylight saving time', () => {
    expect(new Date(optionExpiryInstantMs('2026-07-31')!).toISOString()).toBe('2026-07-31T20:00:00.000Z');
  });

  it('resolves 16:00 New York during standard time', () => {
    expect(new Date(optionExpiryInstantMs('2026-12-18')!).toISOString()).toBe('2026-12-18T21:00:00.000Z');
  });

  it('rejects a malformed expiration', () => {
    expect(optionExpiryInstantMs('2026-7-3')).toBeNull();
    expect(optionExpiryInstantMs('')).toBeNull();
  });
});
