import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaOptionsProvider } from './options';

vi.mock('server-only', () => ({}));

afterEach(() => vi.unstubAllGlobals());

const CREDENTIALS = { keyId: 'key-id', secretKey: 'secret-key' };
const AT = () => new Date('2026-07-27T15:00:00.000Z');

/** Field-for-field shape of a real Alpaca /v2/options/contracts row. */
function contract(overrides: Record<string, unknown> = {}) {
  return {
    id: '3ef0a37a',
    symbol: 'AAPL260821C00345000',
    name: 'AAPL Aug 21 2026 345 Call',
    status: 'active',
    tradable: true,
    expiration_date: '2026-08-21',
    root_symbol: 'AAPL',
    underlying_symbol: 'AAPL',
    type: 'call',
    style: 'american',
    strike_price: '345',
    multiplier: '100',
    size: '100',
    open_interest: '46635',
    open_interest_date: '2026-07-23',
    close_price: '1.06',
    close_price_date: '2026-07-23',
    ...overrides,
  };
}

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

describe('AlpacaOptionsProvider', () => {
  it('normalizes real open interest and keeps unsupplied Greeks/IV null rather than fabricating them', async () => {
    vi.stubGlobal('fetch', respond({ option_contracts: [contract()], next_page_token: null }));
    const result = await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');

    expect(result.provider).toBe('alpaca');
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toEqual(expect.objectContaining({
      contractSymbol: 'AAPL260821C00345000',
      underlyingSymbol: 'AAPL',
      type: 'call',
      expiration: '2026-08-21',
      strike: 345,
      openInterest: 46635,
      last: 1.06,
      multiplier: 100,
      currency: 'USD',
    }));
    for (const field of ['bid', 'ask', 'volume', 'impliedVolatility', 'delta', 'gamma', 'theta', 'vega', 'rho'] as const) {
      expect(result.contracts[0][field]).toBeNull();
    }
  });

  it('reports the chain as delayed and discloses the end-of-day open-interest date', async () => {
    vi.stubGlobal('fetch', respond({ option_contracts: [contract()] }));
    const result = await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');

    expect(result.status).toBe('delayed');
    expect(result.timestampKind).toBe('receipt');
    expect(result.asOf).toBe('2026-07-27T15:00:00.000Z');
    expect(result.warnings.join(' ')).toMatch(/settled on 2026-07-23/);
    expect(result.warnings.join(' ')).toMatch(/implied volatility, or Greeks/i);
  });

  it('sends credentials as headers and never as query parameters', async () => {
    const fetcher = respond({ option_contracts: [contract()] });
    vi.stubGlobal('fetch', fetcher);
    await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).not.toMatch(/key-id|secret-key/);
    expect((init.headers as Record<string, string>)['APCA-API-KEY-ID']).toBe('key-id');
    expect((init.headers as Record<string, string>)['APCA-API-SECRET-KEY']).toBe('secret-key');
  });

  it('asks for one unpaginated call-only page when discovering expirations', async () => {
    const fetcher = respond({ option_contracts: [contract(), contract({ symbol: 'AAPL260918C00345000', expiration_date: '2026-09-18' })] });
    vi.stubGlobal('fetch', fetcher);
    const result = await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL');

    const url = (fetcher.mock.calls[0] as unknown as [URL])[0];
    expect(url.searchParams.get('type')).toBe('call');
    expect(url.searchParams.get('expiration_date_gte')).toBe('2026-07-27');
    expect(url.searchParams.get('limit')).toBe('10000');
    expect(url.searchParams.get('underlying_symbols')).toBe('AAPL');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.expirations).toEqual(['2026-08-21', '2026-09-18']);
  });

  it('scopes a chain request to the requested expiration only', async () => {
    const fetcher = respond({ option_contracts: [contract()] });
    vi.stubGlobal('fetch', fetcher);
    await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');

    const url = (fetcher.mock.calls[0] as unknown as [URL])[0];
    expect(url.searchParams.get('expiration_date')).toBe('2026-08-21');
    expect(url.searchParams.has('type')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry a throttled upstream inside one route invocation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'too many requests' }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL'))
      .rejects.toMatchObject({ code: 'rate-limited', retryAfterSeconds: 30 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('classifies an Alpaca entitlement refusal as forbidden, not as a retryable throttle', async () => {
    vi.stubGlobal('fetch', respond({ message: 'OPRA agreement is not signed' }, 403));
    await expect(new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL'))
      .rejects.toMatchObject({ code: 'forbidden', retryable: false });
  });

  it('reports an empty catalogue as no-data instead of an empty chain', async () => {
    vi.stubGlobal('fetch', respond({ option_contracts: [], next_page_token: null }));
    await expect(new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL'))
      .rejects.toMatchObject({ code: 'not-found' });

    vi.stubGlobal('fetch', respond({ option_contracts: null }));
    await expect(new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL'))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('drops rows that fail the canonical contract instead of emitting partial junk', async () => {
    vi.stubGlobal('fetch', respond({ option_contracts: [
      contract(),
      contract({ symbol: 'BAD', strike_price: '0' }),
      contract({ symbol: 'BAD2', expiration_date: 'not-a-date' }),
    ] }));
    const result = await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].contractSymbol).toBe('AAPL260821C00345000');
  });

  it('treats a missing open interest as unknown rather than zero', async () => {
    vi.stubGlobal('fetch', respond({ option_contracts: [contract({ open_interest: null, open_interest_date: null })] }));
    const result = await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');
    expect(result.contracts[0].openInterest).toBeNull();
  });

  it('rejects a response whose shape does not match the validated schema', async () => {
    vi.stubGlobal('fetch', respond({ unexpected: true }));
    await expect(new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL'))
      .rejects.toMatchObject({ code: 'invalid-provider-response' });
  });

  it('uses the paper trading host by default and honours an explicit override', async () => {
    const fetcher = respond({ option_contracts: [contract()] });
    vi.stubGlobal('fetch', fetcher);
    await new AlpacaOptionsProvider(CREDENTIALS, undefined, AT).getOptionsContracts('AAPL', '2026-08-21');
    expect(String((fetcher.mock.calls[0] as unknown as [URL])[0])).toContain('https://paper-api.alpaca.markets/v2/options/contracts');

    const override = respond({ option_contracts: [contract()] });
    vi.stubGlobal('fetch', override);
    await new AlpacaOptionsProvider({ ...CREDENTIALS, baseUrl: 'https://api.alpaca.markets/' }, undefined, AT)
      .getOptionsContracts('AAPL', '2026-08-21');
    expect(String((override.mock.calls[0] as unknown as [URL])[0])).toContain('https://api.alpaca.markets/v2/options/contracts');
  });
});
