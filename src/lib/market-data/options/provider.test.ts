import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlphaVantageOptionsProvider } from '../providers/alpha-vantage/options';
import { OptionsMarketDataService } from './service';

vi.mock('server-only', () => ({}));

afterEach(() => vi.unstubAllGlobals());

describe('real options provider boundary', () => {
  it('maps a plan entitlement response to forbidden without accepting sample data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      Information: 'This premium endpoint requires a subscription or upgraded plan.',
    }), { headers: { 'Content-Type': 'application/json' } })));
    await expect(new AlphaVantageOptionsProvider('secret').getOptionsContracts('RKLB'))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects provider-labelled artificial sample payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      Information: 'The data in this response is artificial for demonstration.',
      data: [],
    }), { headers: { 'Content-Type': 'application/json' } })));
    await expect(new AlphaVantageOptionsProvider('secret').getOptionsContracts('RKLB'))
      .rejects.toMatchObject({ code: 'invalid-provider-response' });
  });

  it('normalizes a validated real row and discloses the provider-omitted multiplier assumption', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ endpoint: 'REALTIME_OPTIONS', data: [{
      contractID: 'RKLB260821C00050000', symbol: 'RKLB', expiration: '2026-08-21', strike: '50', type: 'call',
      last: '1.1', mark: '1.15', bid: '1.1', ask: '1.2', volume: '7', open_interest: '42',
      implied_volatility: '0.35', delta: '0.4', gamma: '0.02', theta: '-0.03', vega: '0.05', rho: '0.01',
    }] }), { headers: { 'Content-Type': 'application/json' } })));
    const result = await new AlphaVantageOptionsProvider('secret', undefined, () => new Date('2026-07-20T15:00:00.000Z')).getOptionsContracts('RKLB');
    expect(result.contracts[0]).toEqual(expect.objectContaining({ contractSymbol: 'RKLB260821C00050000', strike: 50, impliedVolatility: 0.35, multiplier: 100 }));
    expect(result.warnings.join(' ')).toMatch(/multiplier 100/i);
  });

  it('returns unavailable instead of fabricating a chain when no real contract matches', async () => {
    const provider = { id: 'test', getOptionsContracts: vi.fn(async () => ({
      underlyingSymbol: 'RKLB', contracts: [], expirations: [], provider: 'test',
      asOf: '2026-07-20T15:00:00.000Z', status: 'delayed' as const, delayedMinutes: 15,
      completeness: 0, warnings: ['provider returned no contracts'],
    })) };
    const quote = { getQuote: vi.fn(async () => { throw new Error('quote should not be requested'); }) };
    const service = new OptionsMarketDataService(provider, quote);
    await expect(service.getChain('RKLB', '2026-08-21')).rejects.toMatchObject({ code: 'not-found' });
    expect(quote.getQuote).not.toHaveBeenCalled();
  });

  it('keeps options freshness independent when the underlying quote is stale', async () => {
    const normalized = await new AlphaVantageOptionsProvider('secret', {
      json: async () => ({ endpoint: 'REALTIME_OPTIONS', data: [{
        contractID: 'RKLB260821C00050000', symbol: 'RKLB', expiration: '2026-08-21', strike: '50', type: 'call',
        last: '1.1', mark: '1.15', bid: '1.1', ask: '1.2', volume: '7', open_interest: '42',
        implied_volatility: '0.35', delta: '0.4', gamma: '0.02', theta: '-0.03', vega: '0.05', rho: '0.01',
      }] }),
    } as never, () => new Date('2026-07-20T15:00:00.000Z')).getOptionsContracts('RKLB', '2026-08-21');
    const provider = { id: 'test-options', getOptionsContracts: vi.fn(async () => normalized) };
    const quote = { getQuote: vi.fn(async () => ({
      data: { symbol: 'RKLB', price: 50 },
      provider: 'polygon',
      freshness: { status: 'stale' as const, asOf: '2026-07-20T14:00:00.000Z', maxAgeSeconds: 60 },
    })) };
    const result = await new OptionsMarketDataService(provider, quote as never).getChain('RKLB', '2026-08-21');
    expect(result.data.status).toBe('live');
    expect(result.data.underlyingStatus).toBe('stale');
    expect(result.data.underlyingProvider).toBe('polygon');
    expect(result.data.calls[0].status).toBe('live');
  });
});
