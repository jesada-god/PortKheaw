import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaOptionsSnapshotProvider } from './options-snapshots';

vi.mock('server-only', () => ({}));

afterEach(() => vi.unstubAllGlobals());

const CREDENTIALS = { keyId: 'key-id', secretKey: 'secret-key' };
const AT = () => new Date('2026-07-27T15:00:00.000Z');

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('AlpacaOptionsSnapshotProvider', () => {
  it('parses quote, trade, volume, IV and Greeks keyed by the exact contract symbol', async () => {
    const fetcher = vi.fn(async () => response({
      snapshots: {
        AAPL260821C00210000: {
          latestQuote: { bp: 4.2, ap: 4.6, t: '2026-07-27T14:59:58Z' },
          latestTrade: { p: 4.5, t: '2026-07-27T14:59:59Z' },
          dailyBar: { v: 1234 },
          impliedVolatility: 0.275,
          greeks: { delta: 0.6857, gamma: 0.0426, theta: -0.5146, vega: 0.1074, rho: 0.0184 },
        },
      },
      next_page_token: null,
    }));
    vi.stubGlobal('fetch', fetcher);

    const result = await new AlpacaOptionsSnapshotProvider(CREDENTIALS, undefined, AT)
      .getSnapshots('aapl', '2026-08-21');

    expect(result.snapshots.get('AAPL260821C00210000')).toEqual({
      bid: 4.2,
      ask: 4.6,
      last: 4.5,
      volume: 1234,
      impliedVolatility: 0.275,
      delta: 0.6857,
      gamma: 0.0426,
      theta: -0.5146,
      vega: 0.1074,
      rho: 0.0184,
      observedAt: '2026-07-27T14:59:59.000Z',
    });
    expect(result.feed).toBe('indicative');
    expect(result.asOf).toBe('2026-07-27T15:00:00.000Z');

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/v1beta1/options/snapshots/AAPL');
    expect(url.searchParams.get('expiration_date')).toBe('2026-08-21');
    expect(url.searchParams.get('feed')).toBe('indicative');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(String(url)).not.toMatch(/key-id|secret-key/);
    expect((init.headers as Record<string, string>)['APCA-API-KEY-ID']).toBe('key-id');
    expect((init.headers as Record<string, string>)['APCA-API-SECRET-KEY']).toBe('secret-key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable fields null and rejects a crossed book instead of inventing zeroes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ snapshots: {
      MISSING: { latestQuote: { bp: 0, ap: 1 } },
      CROSSED: { latestQuote: { bp: 5, ap: 4 } },
    } })));

    const result = await new AlpacaOptionsSnapshotProvider(CREDENTIALS, undefined, AT)
      .getSnapshots('AAPL', '2026-08-21');

    expect(result.snapshots.get('MISSING')).toMatchObject({
      bid: null, ask: 1, last: null, volume: null, impliedVolatility: null,
      delta: null, gamma: null, theta: null, vega: null, rho: null,
    });
    expect(result.snapshots.get('CROSSED')).toMatchObject({ bid: null, ask: null });
  });

  it('bounds pagination at four pages and never turns one load into an unbounded burst', async () => {
    let page = 0;
    const fetcher = vi.fn(async () => {
      page += 1;
      return response({ snapshots: { [`CONTRACT-${page}`]: {} }, next_page_token: `page-${page + 1}` });
    });
    vi.stubGlobal('fetch', fetcher);

    const result = await new AlpacaOptionsSnapshotProvider(CREDENTIALS, undefined, AT)
      .getSnapshots('AAPL', '2026-08-21');

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.snapshots.size).toBe(4);
    expect(result.warnings.join(' ')).toMatch(/truncated at the bounded page limit/i);
  });

  it('degrades an unentitled feed to an empty enrichment with no retry storm', async () => {
    const fetcher = vi.fn(async () => response(
      { message: 'OPRA agreement is not signed' },
      403,
    ));
    vi.stubGlobal('fetch', fetcher);

    const result = await new AlpacaOptionsSnapshotProvider(
      { ...CREDENTIALS, feed: 'opra' }, undefined, AT,
    ).getSnapshots('AAPL', '2026-08-21');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.snapshots.size).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/not entitled on the opra feed/i);
  });
});
