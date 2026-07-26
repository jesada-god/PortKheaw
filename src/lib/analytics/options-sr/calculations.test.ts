import { describe, expect, it } from 'vitest';
import type { OptionContract } from '@/src/lib/market-data/options/contracts';
import { computeOptionsSupportResistance, type OptionsSrInput } from './index';

const NOW_MS = Date.UTC(2026, 6, 21); // 2026-07-21
const EXPIRATION = '2026-08-21';

interface Overrides {
  type: 'call' | 'put';
  strike: number;
  openInterest?: number | null;
  volume?: number | null;
  delta?: number | null;
  gamma?: number | null;
  multiplier?: number;
  status?: OptionContract['status'];
  contractSymbol?: string;
  expiration?: string;
  asOf?: string;
}

function contract(overrides: Overrides): OptionContract {
  return {
    contractSymbol: overrides.contractSymbol ?? `${overrides.type}-${overrides.strike}`,
    underlyingSymbol: 'RKLB',
    type: overrides.type,
    expiration: overrides.expiration ?? EXPIRATION,
    strike: overrides.strike,
    bid: null, ask: null, last: null, mark: null,
    volume: overrides.volume ?? null,
    openInterest: overrides.openInterest ?? null,
    impliedVolatility: null,
    delta: overrides.delta ?? null,
    gamma: overrides.gamma ?? null,
    theta: null, vega: null, rho: null,
    inTheMoney: null,
    multiplier: overrides.multiplier ?? 100,
    currency: 'USD',
    provider: 'alpha-vantage',
    asOf: overrides.asOf ?? '2026-07-21T00:00:00.000Z',
    timestampKind: 'receipt',
    status: overrides.status ?? 'delayed',
  };
}

function baseInput(partial: Partial<OptionsSrInput>): OptionsSrInput {
  return {
    symbol: 'RKLB',
    expiration: EXPIRATION,
    acceptedPrice: 50,
    calls: [],
    puts: [],
    provider: 'alpha-vantage',
    asOf: '2026-07-21T00:00:00.000Z',
    status: 'delayed',
    ...partial,
  };
}

describe('computeOptionsSupportResistance — Call/Put walls', () => {
  const calls = [
    contract({ type: 'call', strike: 40, openInterest: 50 }),
    contract({ type: 'call', strike: 49, openInterest: 300 }),
    contract({ type: 'call', strike: 50, openInterest: 500 }),
    contract({ type: 'call', strike: 51, openInterest: 450 }),
    contract({ type: 'call', strike: 60, openInterest: 120 }),
  ];
  const puts = [
    contract({ type: 'put', strike: 40, openInterest: 600 }),
    contract({ type: 'put', strike: 41, openInterest: 200 }),
    contract({ type: 'put', strike: 45, openInterest: 90 }),
    contract({ type: 'put', strike: 50, openInterest: 120 }),
  ];

  it('clusters the Call Wall from the peak OI strike and its adjacent strikes', () => {
    const result = computeOptionsSupportResistance(
      baseInput({ calls, puts }),
      { nowMs: NOW_MS, clusterTolerancePercent: 0.03, minStrikes: 4 },
    );
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const wall = result.callWall!;
    // tolerance = 50 * 0.03 = 1.5 → strikes 49, 50, 51 join the cluster around peak 50.
    expect(wall.price).toBe(50);
    expect(wall.rawOI).toBe(500);
    expect(wall.clusterOI).toBe(300 + 500 + 450);
    expect(wall.method).toBe('call-oi-concentration');
    expect(wall.source).toBe('call-oi');
    expect(result.totalCallOI).toBe(50 + 300 + 500 + 450 + 120);
    expect(wall.oiSharePercent).toBeCloseTo((1250 / 1420) * 100, 1);
    expect(wall.greekVariants).toBeUndefined();
  });

  it('clusters the Put Wall on the put side independently', () => {
    const result = computeOptionsSupportResistance(
      baseInput({ calls, puts }),
      { nowMs: NOW_MS, clusterTolerancePercent: 0.03, minStrikes: 4 },
    );
    if (result.status !== 'available') throw new Error('expected available');
    const wall = result.putWall!;
    // peak put OI is strike 40; 41 is within tolerance 1.5 → cluster {40,41}.
    expect(wall.price).toBe(40);
    expect(wall.rawOI).toBe(600);
    expect(wall.clusterOI).toBe(600 + 200);
    expect(wall.source).toBe('put-oi');
    expect(result.putCallOIRatio).toBeCloseTo(result.totalPutOI / result.totalCallOI, 4);
  });

  it('exposes optional Greek-weighted variants only when real Greeks exist', () => {
    const greekCalls = [
      contract({ type: 'call', strike: 49, openInterest: 300, delta: 0.55, gamma: 0.02 }),
      contract({ type: 'call', strike: 50, openInterest: 500, delta: 0.5, gamma: 0.03 }),
      contract({ type: 'call', strike: 51, openInterest: 450, delta: 0.45, gamma: 0.02 }),
      contract({ type: 'call', strike: 60, openInterest: 120, delta: 0.2, gamma: 0.01 }),
    ];
    const result = computeOptionsSupportResistance(
      baseInput({ calls: greekCalls, puts }),
      { nowMs: NOW_MS, clusterTolerancePercent: 0.03, minStrikes: 4 },
    );
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.callWall!.greekVariants).toBeDefined();
    expect(Number.isFinite(result.callWall!.greekVariants!.gamma!)).toBe(true);
    expect(Number.isFinite(result.callWall!.greekVariants!.delta!)).toBe(true);
  });
});

describe('computeOptionsSupportResistance — Max Pain', () => {
  it('selects the minimum-total-payout strike deterministically', () => {
    const input = baseInput({
      acceptedPrice: 105,
      calls: [
        contract({ type: 'call', strike: 100, openInterest: 10, multiplier: 1 }),
        contract({ type: 'call', strike: 110, openInterest: 10, multiplier: 1 }),
      ],
      puts: [
        contract({ type: 'put', strike: 100, openInterest: 10, multiplier: 1 }),
        contract({ type: 'put', strike: 110, openInterest: 20, multiplier: 1 }),
      ],
    });
    const result = computeOptionsSupportResistance(input, { nowMs: NOW_MS, minStrikes: 2 });
    if (result.status !== 'available') throw new Error('expected available');
    // K=100 → putPayout 20*10=200; K=110 → callPayout 10*10=100. Min at 110.
    expect(result.maxPain!.price).toBe(110);
    expect(result.maxPain!.method).toBe('min-total-payout');
    expect(result.maxPain!.source).toBe('max-pain');
  });

  it('breaks a payout tie by nearest accepted price then the lower strike', () => {
    const input = baseInput({
      acceptedPrice: 105,
      calls: [
        contract({ type: 'call', strike: 100, openInterest: 10, multiplier: 1 }),
        contract({ type: 'call', strike: 110, openInterest: 10, multiplier: 1 }),
      ],
      puts: [
        contract({ type: 'put', strike: 100, openInterest: 10, multiplier: 1 }),
        contract({ type: 'put', strike: 110, openInterest: 10, multiplier: 1 }),
      ],
    });
    const result = computeOptionsSupportResistance(input, { nowMs: NOW_MS, minStrikes: 2 });
    if (result.status !== 'available') throw new Error('expected available');
    // Both K=100 and K=110 total 100; equidistant from 105 → lower strike 100 wins.
    expect(result.maxPain!.price).toBe(100);
  });
});

describe('computeOptionsSupportResistance — data quality & typed unavailable', () => {
  it('deduplicates duplicate contract identities deterministically, independent of order', () => {
    const rows = [
      contract({ type: 'call', strike: 50, openInterest: 100, contractSymbol: 'C50' }),
      contract({ type: 'call', strike: 50, openInterest: 500, contractSymbol: 'C50' }),
      contract({ type: 'call', strike: 60, openInterest: 200, contractSymbol: 'C60' }),
    ];
    const forward = computeOptionsSupportResistance(baseInput({ calls: rows }), { nowMs: NOW_MS, minStrikes: 2, minOiCoverage: 0 });
    const reversed = computeOptionsSupportResistance(baseInput({ calls: [...rows].reverse() }), { nowMs: NOW_MS, minStrikes: 2, minOiCoverage: 0 });
    if (forward.status !== 'available' || reversed.status !== 'available') throw new Error('expected available');
    // The higher-OI duplicate (500) wins; 100 is dropped → total 500 + 200.
    expect(forward.totalCallOI).toBe(700);
    expect(reversed.totalCallOI).toBe(700);
    expect(forward.callWall!.rawOI).toBe(500);
  });

  it('returns a typed no-open-interest when the provider supplied no OI', () => {
    const calls = [
      contract({ type: 'call', strike: 50 }),
      contract({ type: 'call', strike: 55 }),
    ];
    const result = computeOptionsSupportResistance(baseInput({ calls }), { nowMs: NOW_MS });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('no-open-interest');
  });

  it('does not block OI-based walls when Greeks are missing', () => {
    const calls = [
      contract({ type: 'call', strike: 49, openInterest: 300 }),
      contract({ type: 'call', strike: 50, openInterest: 500 }),
      contract({ type: 'call', strike: 51, openInterest: 450 }),
    ];
    const puts = [contract({ type: 'put', strike: 40, openInterest: 200 })];
    const result = computeOptionsSupportResistance(baseInput({ calls, puts }), { nowMs: NOW_MS, minStrikes: 3, clusterTolerancePercent: 0.03 });
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.callWall).not.toBeNull();
    expect(result.callWall!.greekVariants).toBeUndefined();
  });

  it('rejects a chain below the documented coverage thresholds', () => {
    const calls = [
      contract({ type: 'call', strike: 50, openInterest: 500 }),
      contract({ type: 'call', strike: 55, openInterest: 400 }),
    ];
    const result = computeOptionsSupportResistance(baseInput({ calls }), { nowMs: NOW_MS });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('insufficient-coverage');
  });

  it('excludes stale contracts and withholds a stale chain', () => {
    const result = computeOptionsSupportResistance(
      baseInput({ status: 'stale', calls: [contract({ type: 'call', strike: 50, openInterest: 500 })] }),
      { nowMs: NOW_MS },
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('stale');
  });

  it('rejects an expired expiration', () => {
    const result = computeOptionsSupportResistance(
      baseInput({ expiration: '2020-01-01', calls: [contract({ type: 'call', strike: 50, openInterest: 500, expiration: '2020-01-01' })] }),
      { nowMs: NOW_MS },
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('expired-expiration');
  });
});

describe('computeOptionsSupportResistance — truthfulness & numeric safety', () => {
  const calls = [
    contract({ type: 'call', strike: 49, openInterest: 300 }),
    contract({ type: 'call', strike: 50, openInterest: 500 }),
    contract({ type: 'call', strike: 51, openInterest: 450 }),
    contract({ type: 'call', strike: 60, openInterest: 120 }),
  ];
  const puts = [
    contract({ type: 'put', strike: 40, openInterest: 600 }),
    contract({ type: 'put', strike: 45, openInterest: 200 }),
  ];

  it('never labels delayed/EOD data as real-time and maps DELAYED', () => {
    const result = computeOptionsSupportResistance(baseInput({ calls, puts, status: 'delayed' }), { nowMs: NOW_MS, minStrikes: 4, clusterTolerancePercent: 0.03 });
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.dataMode).toBe('DELAYED');
    expect(JSON.stringify(result)).not.toMatch(/real[\s_-]?time/i);
  });

  it('produces no NaN or Infinity in any numeric field', () => {
    const result = computeOptionsSupportResistance(baseInput({ calls, puts }), { nowMs: NOW_MS, minStrikes: 4, clusterTolerancePercent: 0.03 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/NaN|Infinity/);
    if (result.status !== 'available') throw new Error('expected available');
    for (const level of [result.callWall, result.putWall, result.maxPain]) {
      if (!level) continue;
      for (const value of [level.price, level.distancePercent, level.rawOI, level.clusterOI, level.oiSharePercent]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});
