import { describe, expect, it, vi } from 'vitest';
import type { MarketSignalResult } from './types';

vi.mock('server-only', () => ({}));

const { loadEntitledMarketSignal } = await import('./entitled-service');

describe('loadEntitledMarketSignal', () => {
  it.each(['basic', 'pro'] as const)('does not load or compute Technical Outlook for %s', async (tier) => {
    const load = vi.fn();

    await expect(loadEntitledMarketSignal('AAPL', tier, { load })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the real result for Elite and active Trial effective tier', async () => {
    const result = { status: 'insufficient-data', symbol: 'AAPL' } as MarketSignalResult;
    const load = vi.fn(async () => result);

    await expect(loadEntitledMarketSignal('AAPL', 'elite', { load })).resolves.toBe(result);
    expect(load).toHaveBeenCalledOnce();
  });
});
