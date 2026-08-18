import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle, MarketSignalResult } from './types';

vi.mock('server-only', () => ({}));

const { loadEntitledMarketSignal } = await import('./entitled-service');

const EQUITY = 'technical.outlook' as const;
const COMMODITY = 'technical.outlook.commodity' as const;

describe('loadEntitledMarketSignal', () => {
  it.each(['basic', 'pro'] as const)('does not load or compute Technical Outlook for %s', async (tier) => {
    const load = vi.fn();

    await expect(loadEntitledMarketSignal('AAPL', tier, EQUITY, { load })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the real result for Elite and active Trial effective tier', async () => {
    const result = { status: 'insufficient-data', symbol: 'AAPL' } as MarketSignalResult;
    const load = vi.fn(async () => result);

    await expect(loadEntitledMarketSignal('AAPL', 'elite', EQUITY, { load })).resolves.toBe(result);
    expect(load).toHaveBeenCalledOnce();
  });

  /**
   * The equity gate is the default, so a caller that has not been told which
   * capability applies still gets the Elite behaviour it had before the
   * commodity row existed.
   */
  it('defaults to the equity capability when none is named', async () => {
    const load = vi.fn(async () => ({ status: 'insufficient-data', symbol: 'AAPL' } as MarketSignalResult));

    await expect(loadEntitledMarketSignal('AAPL', 'pro', undefined, { load })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await expect(loadEntitledMarketSignal('AAPL', 'elite', undefined, { load })).resolves.not.toBeNull();
  });

  /**
   * The point of the split. A contract's signal is a Pro value, so Pro reaches
   * the engine here where it would be refused for a stock — and Basic still
   * cannot, which is what makes this a gate rather than a relabelling.
   */
  it('opens a commodity contract to Pro while a stock stays Elite at the same tier', async () => {
    const result = { status: 'insufficient-data', symbol: 'GC-F' } as MarketSignalResult;
    const load = vi.fn(async () => result);

    await expect(loadEntitledMarketSignal('GC-F', 'pro', COMMODITY, { load })).resolves.toBe(result);
    await expect(loadEntitledMarketSignal('GC-F', 'elite', COMMODITY, { load })).resolves.toBe(result);
    expect(load).toHaveBeenCalledTimes(2);

    // Same reader, same instant, the equity row: still refused.
    await expect(loadEntitledMarketSignal('AAPL', 'pro', EQUITY, { load })).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('still refuses Basic on a commodity, without touching the candles', async () => {
    const load = vi.fn();

    await expect(loadEntitledMarketSignal('CL-F', 'basic', COMMODITY, { load })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

/**
 * The rollout phases add FIELDS to the result, and the result is a server value
 * that either exists for a reader or does not. So the check that matters as P3
 * lands is not "is the row hidden" — it is that an unentitled reader's payload
 * has nothing in it to hide.
 *
 * These run the real engine over a real capture rather than a stub, because a
 * stub cannot leak a field it never had, which would make the assertion vacuous.
 */
describe('what an unentitled reader actually receives', () => {
  const frozen = JSON.parse(
    readFileSync(join(process.cwd(), '__golden__', 'candles', 'IREN.json'), 'utf8'),
  ) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

  /**
   * Every phase on at once — the widest payload a reader can be served today.
   *
   * `history` is stapled on rather than computed, because it is the one phase
   * field the ENGINE cannot produce: `calculateMarketSignal` is pure over the
   * candles in front of it and `loadMarketSignal` is what reads yesterday back
   * out of the database. It has to be here anyway — the question this block
   * asks is what an unentitled reader receives, and a field the boundary has
   * never been shown cannot be proven absent.
   */
  const load = async (): Promise<MarketSignalResult> => ({
    ...calculateMarketSignal(frozen.candles, {
      symbol: 'IREN',
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: '2026-01-01T00:00:00.000Z',
      features: { gate: true, zones: true, actionable: true },
    }),
    history: {
      entries: [{
        asOf: '2026-01-01',
        state: 'SIDEWAYS',
        bias: 'neutral',
        zone: 'sideways',
        score: 4,
        evidenceAgreement: 61,
        flags: [],
      }],
      windowDays: 30,
      currentLabelDays: null,
      recentFlip: false,
    },
  });

  const PHASE_FIELDS = ['gate', 'zones', 'actionable', 'history'];

  const PATHS: Array<{ name: string; tier: SubscriptionTier; capability: 'technical.outlook' | 'technical.outlook.commodity'; entitled: boolean }> = [
    { name: 'Basic on a stock', tier: 'basic', capability: 'technical.outlook', entitled: false },
    { name: 'Pro on a stock', tier: 'pro', capability: 'technical.outlook', entitled: false },
    { name: 'Elite on a stock', tier: 'elite', capability: 'technical.outlook', entitled: true },
    { name: 'Basic on a contract', tier: 'basic', capability: 'technical.outlook.commodity', entitled: false },
    { name: 'Pro on a contract', tier: 'pro', capability: 'technical.outlook.commodity', entitled: true },
  ];

  it.each(PATHS)('$name', async ({ tier, capability, entitled }) => {
    const result = await loadEntitledMarketSignal('IREN', tier, capability, { load });
    if (!entitled) {
      expect(result).toBeNull();
      // Nothing to serialise means nothing to leak, at any phase, ever.
      expect(JSON.stringify(result)).toBe('null');
      return;
    }
    expect(result).not.toBeNull();
    PHASE_FIELDS.forEach((field) => expect(field in result!).toBe(true));
  });

  /*
   * The trial is the path that changes underneath a reader rather than at a
   * checkout. An Elite trial that has run out resolves to `basic`, and from
   * there it is the Basic path above — including for the fields P3 just added.
   */
  it('gives an expired Elite trial the Basic payload, which is no payload', async () => {
    const now = '2026-08-18T00:00:00.000Z';
    const active = resolveEffectiveTier(
      { tier: 'elite', status: 'trialing', trialEndsAt: '2026-08-19T00:00:00.000Z', currentPeriodEnd: null },
      now,
    );
    const expired = resolveEffectiveTier(
      { tier: 'elite', status: 'trialing', trialEndsAt: '2026-08-17T00:00:00.000Z', currentPeriodEnd: null },
      now,
    );
    expect(active).toBe('elite');
    expect(expired).toBe('basic');

    const during = await loadEntitledMarketSignal('IREN', active, 'technical.outlook', { load });
    const after = await loadEntitledMarketSignal('IREN', expired, 'technical.outlook', { load });
    expect(during?.actionable).toBeDefined();
    expect(during?.history).toBeDefined();
    expect(after).toBeNull();
    expect(JSON.stringify(after)).not.toContain('actionable');
    // The strip is a record of everything this card has ever said about the
    // symbol, so it is the single worst field to leak past the boundary.
    expect(JSON.stringify(after)).not.toContain('history');
  });

  /*
   * The other half of the contract: no field that shipped before P3 was removed
   * or changed shape by it. Checked against the flags-OFF payload, which is what
   * every reader is served until an owner sets the variable.
   */
  it('adds fields to the entitled payload without taking any away', async () => {
    const off = calculateMarketSignal(frozen.candles, {
      symbol: 'IREN',
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: '2026-01-01T00:00:00.000Z',
    });
    const on = await load();
    const fields = (result: MarketSignalResult) => result as unknown as Record<string, unknown>;
    Object.keys(off).forEach((key) => {
      expect(key in on).toBe(true);
      expect(typeof fields(on)[key]).toBe(typeof fields(off)[key]);
    });
    expect(Object.keys(off).some((key) => PHASE_FIELDS.includes(key))).toBe(false);
  });
});
