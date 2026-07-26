import { describe, expect, it, vi } from 'vitest';
import { fetchFinnhubRestSnapshot } from './rest-snapshot';

describe('fetchFinnhubRestSnapshot', () => {
  it('uses only the real quote fields and leaves unsupported book/bars absent', async () => {
    const timestamp = Math.floor(Date.UTC(2026, 6, 24, 20, 0) / 1_000);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      c: 173.5, d: 1.2, dp: 0.7, h: 175, l: 170, o: 171, pc: 172.3, t: timestamp,
    }), { status: 200 })) as unknown as typeof fetch;
    const snapshot = await fetchFinnhubRestSnapshot('nvda', {
      apiKey: 'server-secret', fetchImpl, now: () => 123,
    });
    expect(snapshot).toMatchObject({
      symbol: 'NVDA', origin: 'rest', quote: null, bars: [], asOfMs: 123,
      trade: { price: 173.5, size: 0, provider: 'finnhub' },
    });
    const url = String(vi.mocked(fetchImpl).mock.calls[0][0]);
    expect(url).toContain('symbol=NVDA');
    expect(url).toContain('token=server-secret');
  });

  it('returns unavailable instead of fabricating a zero provider response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ c: 0, t: 0 }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchFinnhubRestSnapshot('NVDA', { apiKey: 'secret', fetchImpl })).resolves.toBeNull();
  });
});
