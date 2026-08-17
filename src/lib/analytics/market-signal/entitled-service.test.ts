import { describe, expect, it, vi } from 'vitest';
import type { MarketSignalResult } from './types';

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
