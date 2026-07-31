import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialModelingPrepProfileProvider } from './provider';

vi.mock('server-only', () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Financial Modeling Prep Company Profile provider', () => {
  it('normalizes the existing CompanyProfile contract and uses null for missing fields', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify([{
      symbol: 'RKLB',
      companyName: 'Rocket Lab USA, Inc.',
      description: 'Rocket Lab provides launch and space systems.',
      country: 'US',
      currency: 'USD',
      sector: 'Industrials',
      industry: 'Aerospace & Defense',
      website: 'https://www.rocketlabusa.com',
      exchange: 'NASDAQ',
      marketCap: 20_000_000_000,
      fullTimeEmployees: null,
      fiscalYearEnd: 'December',
    }]), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);

    const response = await new FinancialModelingPrepProfileProvider('secret')
      .getCompanyProfile('RKLB');

    expect(response.provider).toBe('financial-modeling-prep');
    expect(response.data).toEqual({
      symbol: 'RKLB',
      name: 'Rocket Lab USA, Inc.',
      description: 'Rocket Lab provides launch and space systems.',
      country: 'US',
      employees: null,
      currency: 'USD',
      fiscalYearEnd: 'December',
      sector: 'Industrials',
      industry: 'Aerospace & Defense',
      marketCapitalization: 20_000_000_000,
      website: 'https://www.rocketlabusa.com/',
      logoUrl: null,
      exchange: 'NASDAQ',
      latestQuarter: null,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain('secret');
    expect(init?.headers).toMatchObject({ apikey: 'secret' });
  });

  it('rejects an empty profile response so the service can continue the chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(
      new FinancialModelingPrepProfileProvider('secret').getCompanyProfile('RKLB'),
    ).rejects.toMatchObject({ code: 'invalid-provider-response' });
  });

  it('preserves secondary Retry-After without retrying', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ message: 'Too many requests' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '25',
        },
      },
    ));
    vi.stubGlobal('fetch', fetcher);

    await expect(
      new FinancialModelingPrepProfileProvider('secret').getCompanyProfile('RKLB'),
    ).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 25,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
