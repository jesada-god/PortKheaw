import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlphaVantageOptionsProvider } from '../providers/alpha-vantage/options';
import { MarketDataError } from '../errors';
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
    expect(result).toMatchObject({ asOf: '2026-07-20T15:00:00.000Z', timestampKind: 'receipt' });
    expect(result.contracts[0]).toEqual(expect.objectContaining({ contractSymbol: 'RKLB260821C00050000', strike: 50, impliedVolatility: 0.35, multiplier: 100, timestampKind: 'receipt' }));
    expect(result.warnings.join(' ')).toMatch(/multiplier 100/i);
  });

  it('returns unavailable instead of fabricating a chain when no real contract matches', async () => {
    const provider = { id: 'test', getOptionsContracts: vi.fn(async () => ({
      underlyingSymbol: 'RKLB', contracts: [], expirations: [], provider: 'test',
      asOf: '2026-07-20T15:00:00.000Z', timestampKind: 'provider' as const, status: 'delayed' as const, delayedMinutes: 15,
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
    expect(result.data.status).toBe('delayed');
    expect(result.data.underlyingStatus).toBe('stale');
    expect(result.data.underlyingProvider).toBe('polygon');
    expect(result.data.calls[0].status).toBe('delayed');
    expect(result.data.timestampKind).toBe('receipt');
    expect(result.data.calls[0].timestampKind).toBe('receipt');
  });

  it('reuses the fresh full snapshot for a selected chain instead of calling the provider twice', async () => {
    const normalized = await new AlphaVantageOptionsProvider('secret', {
      json: async () => ({ endpoint: 'REALTIME_OPTIONS', data: [{
        contractID: 'AAPL260821C00200000', symbol: 'AAPL', expiration: '2026-08-21', strike: '200', type: 'call',
        last: '8', mark: '8.1', bid: '8', ask: '8.2', volume: '10', open_interest: '100',
        implied_volatility: '0.25', delta: '0.55', gamma: '0.02', theta: '-0.03', vega: '0.1', rho: '0.01',
      }] }),
    } as never, () => new Date('2026-07-20T15:00:00.000Z')).getOptionsContracts('AAPL');
    const provider = { id: 'alpha-vantage', getOptionsContracts: vi.fn(async () => normalized) };
    const quote = { getQuote: vi.fn(async () => ({
      data: { symbol: 'AAPL', price: 203 }, provider: 'quote-provider',
      freshness: { status: 'realtime' as const, asOf: '2026-07-20T15:00:00.000Z', maxAgeSeconds: 60 },
    })) };
    const service = new OptionsMarketDataService(provider, quote as never);
    await service.getExpirations('AAPL');
    const chain = await service.getChain('AAPL', '2026-08-21');
    expect(provider.getOptionsContracts).toHaveBeenCalledTimes(1);
    expect(chain.data).toMatchObject({ expiration: '2026-08-21', status: 'cached', provider: 'alpha-vantage' });
  });

  it('uses the next configured real provider boundary after a primary 429', async () => {
    const primary = {
      id: 'primary-options',
      getOptionsContracts: vi.fn(async () => { throw new MarketDataError('rate-limited', 'quota', 45); }),
    };
    const fallback = {
      id: 'fallback-options',
      getOptionsContracts: vi.fn(async () => ({
        underlyingSymbol: 'AAPL', contracts: [], expirations: ['2026-08-21'], provider: 'fallback-options',
        asOf: '2026-07-20T15:00:00.000Z', timestampKind: 'provider' as const, status: 'delayed' as const,
        delayedMinutes: 15, completeness: 1, warnings: [],
      })),
    };
    const quote = { getQuote: vi.fn() };
    const result = await new OptionsMarketDataService([primary, fallback], quote as never).getExpirations('AAPL');
    expect(primary.getOptionsContracts).toHaveBeenCalledTimes(1);
    expect(fallback.getOptionsContracts).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'fallback-options', data: { provider: 'fallback-options', status: 'delayed' } });
  });

  it('respects provider Retry-After on the server without a retry storm', async () => {
    let now = 1_000;
    const provider = {
      id: 'limited-options',
      getOptionsContracts: vi.fn(async () => { throw new MarketDataError('rate-limited', 'quota', 45); }),
    };
    const service = new OptionsMarketDataService(provider, { getQuote: vi.fn() } as never, undefined, () => now);
    await expect(service.getExpirations('AAPL')).rejects.toMatchObject({ code: 'rate-limited' });
    now += 30_000;
    await expect(service.getExpirations('AAPL')).rejects.toMatchObject({ code: 'rate-limited', retryAfterSeconds: 15 });
    expect(provider.getOptionsContracts).toHaveBeenCalledTimes(1);
  });
});
