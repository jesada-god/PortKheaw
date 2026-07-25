import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFxRate, resetFxCacheForTests, type FxCacheRepository } from './service';
import type { FxProvider } from './provider';
import type { FxQuote } from './types';

const fetchedAt = '2026-07-18T06:45:00.000Z';
function quote(source = 'primary'): FxQuote {
  return { base: 'USD', quote: 'THB', rate: '36.25', asOf: fetchedAt, fetchedAt, source, cached: false, stale: false };
}
function provider(id: string, result: FxQuote | Error): FxProvider {
  return { id, getRate: vi.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}
function repository(saved: FxQuote | null = null): FxCacheRepository & { get: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => saved), upsert: vi.fn(async () => undefined) };
}

describe('FX service', () => {
  beforeEach(() => resetFxCacheForTests());

  it('persists a successful live quote and returns live flags', async () => {
    const store = repository();
    const result = await getFxRate('USD', 'THB', { providers: [provider('primary', quote())], repository: store, now: Date.parse(fetchedAt) });
    expect(result.quote).toMatchObject({ cached: false, stale: false, source: 'primary' });
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ rate: '36.25' }));
  });

  it('reads persistent cache after an in-memory restart when providers fail', async () => {
    const saved = { ...quote('alpha-vantage'), cached: true, stale: true };
    resetFxCacheForTests();
    const result = await getFxRate('USD', 'THB', { providers: [provider('primary', new Error('offline'))], repository: repository(saved), now: Date.parse('2026-07-20T06:45:00.000Z') });
    expect(result).toMatchObject({ unavailable: true, quote: { rate: '36.25', cached: true, stale: true } });
  });

  it('uses the secondary live provider before database cache', async () => {
    const primary = provider('primary', new Error('offline'));
    const secondary = provider('secondary', quote('secondary'));
    const store = repository({ ...quote('database'), cached: true, stale: true });
    const result = await getFxRate('USD', 'THB', {
      providers: [primary, secondary],
      repository: store,
      now: Date.parse(fetchedAt),
    });
    expect(result.quote).toMatchObject({ source: 'secondary', cached: false, stale: false });
    expect(store.get).not.toHaveBeenCalled();
  });

  it('returns database cache with stale warning state when every provider fails', async () => {
    const result = await getFxRate('USD', 'THB', { providers: [provider('primary', new Error('offline')), provider('secondary', new Error('offline'))], repository: repository({ ...quote(), cached: true, stale: true }), now: Date.parse('2026-07-20T06:45:00.000Z') });
    expect(result).toMatchObject({ unavailable: true, quote: { cached: true, stale: true } });
  });

  it('rejects a last-known rate older than the accepted seven-day window', async () => {
    const result = await getFxRate('USD', 'THB', {
      providers: [provider('primary', new Error('offline'))],
      repository: repository({
        ...quote(),
        asOf: '2026-07-01T06:45:00.000Z',
        fetchedAt: '2026-07-01T06:45:00.000Z',
        cached: true,
        stale: true,
      }),
      now: Date.parse('2026-07-20T06:45:00.000Z'),
    });

    expect(result).toEqual({ quote: null, unavailable: true });
  });

  it('returns unavailable and never invents a 1:1 rate when provider and cache are empty', async () => {
    const result = await getFxRate('USD', 'THB', { providers: [provider('primary', new Error('offline'))], repository: repository(null) });
    expect(result).toEqual({ quote: null, unavailable: true });
    expect(result.quote?.rate).not.toBe('1');
  });
});
