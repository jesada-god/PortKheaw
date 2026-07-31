import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PolygonMarketDataProvider } from './polygon-provider';
import type { ResolvedInstrument } from './contracts';

const instrument: ResolvedInstrument = {
  canonicalSymbol: 'AAPL', providerSymbol: 'AAPL', name: 'Apple Inc.', assetType: 'stock',
  exchange: 'NASDAQ', mic: 'XNAS', currency: 'USD', timezone: 'America/New_York', active: true, supported: true, unsupportedReason: null,
};

function json(payload: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('PolygonMarketDataProvider', () => {
  it('normalizes quote provenance, recency, and previous close', async () => {
    const timestamp = Date.parse('2026-07-20T14:00:00.000Z');
    const fetcher = vi.fn(async () => json({ status: 'OK', ticker: {
      ticker: 'AAPL', updated: timestamp * 1e6,
      lastTrade: { p: 212, t: timestamp * 1e6 }, prevDay: { c: 210 }, day: { o: 211, h: 213, l: 209, c: 212, v: 1234 },
      todaysChange: 2, todaysChangePerc: 0.95238,
    } }));
    const provider = new PolygonMarketDataProvider('secret', () => new Date(timestamp + 30_000), fetcher as typeof fetch);
    await expect(provider.getQuote(instrument)).resolves.toMatchObject({
      symbol: 'AAPL', price: 212, previousClose: 210, status: 'real-time', delayedByMinutes: 0, provider: 'polygon', volume: 1234,
    });
  });

  it('normalizes, sorts, deduplicates, filters regular-session bars, and preserves real values', async () => {
    const result = (iso: string, close: number) => ({ t: Date.parse(iso), o: close - 1, h: close + 1, l: close - 2, c: close, v: 100, n: 4, vw: close - 0.2 });
    const fetcher = vi.fn(async () => json({ status: 'OK', ticker: 'AAPL', results: [
      result('2026-07-17T13:30:00.000Z', 200),
      result('2026-07-20T13:35:00.000Z', 212),
      result('2026-07-20T13:30:00.000Z', 211),
      result('2026-07-20T13:35:00.000Z', 212.5),
      result('2026-07-20T12:00:00.000Z', 209),
    ] }));
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-20T14:00:00.000Z'), fetcher as typeof fetch);
    const output = await provider.getBars({ instrument, interval: '5m', range: '1d', adjusted: false, session: 'regular' });
    expect(output.bars).toHaveLength(2);
    expect(output.bars.map((bar) => bar.close)).toEqual([211, 212.5]);
    expect(output.bars[1]).toMatchObject({ volume: 100, transactions: 4, vwap: 212.3 });
    expect(output.firstTimestamp).toBeLessThan(output.lastTimestamp!);
  });

  it('keeps multi-hour regular-session buckets that overlap 09:30 and excludes those that do not', async () => {
    // Provider-native 4h buckets on a trading Monday (EDT, UTC-4). The 08:00 ET
    // bucket (12:00Z) starts before 09:30 yet spans 08:00–12:00, so it overlaps
    // the open and must be kept with its OHLCV preserved; the premarket 04:00 and
    // after-hours 16:00 buckets lie entirely outside the session and are dropped.
    const result = (iso: string, close: number) => ({ t: Date.parse(iso), o: close - 1, h: close + 1, l: close - 2, c: close, v: 100 });
    const fetcher = vi.fn(async () => json({ status: 'OK', ticker: 'AAPL', results: [
      result('2026-07-20T08:00:00.000Z', 40), // 04:00 ET premarket → excluded
      result('2026-07-20T12:00:00.000Z', 41), // 08:00 ET, 08:00–12:00 overlaps 09:30 → kept
      result('2026-07-20T16:00:00.000Z', 42), // 12:00 ET, fully regular → kept
      result('2026-07-20T20:00:00.000Z', 43), // 16:00 ET after-hours → excluded
    ] }));
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-21T14:00:00.000Z'), fetcher as typeof fetch);

    const regular = await provider.getBars({ instrument, interval: '4h', range: '1m', adjusted: false, session: 'regular' });
    expect(regular.bars.map((bar) => bar.close)).toEqual([41, 42]);
    // The kept bucket's provider OHLCV is preserved unchanged (not split/clipped).
    expect(regular.bars[0]).toMatchObject({ open: 40, high: 42, low: 39, close: 41, volume: 100 });

    // Extended session is separate and never silently substituted: nothing is
    // filtered out, so regular and extended data can never mix.
    const extended = await provider.getBars({ instrument, interval: '4h', range: '1m', adjusted: false, session: 'extended' });
    expect(extended.bars.map((bar) => bar.close)).toEqual([40, 41, 42, 43]);
  });

  it('keeps a 1h bucket straddling the open and drops fully pre/after-hours 1h buckets', async () => {
    const result = (iso: string, close: number) => ({ t: Date.parse(iso), o: close, h: close, l: close, c: close, v: 10 });
    const fetcher = vi.fn(async () => json({ status: 'OK', ticker: 'AAPL', results: [
      result('2026-07-20T12:00:00.000Z', 8),  // 08:00–09:00 ET premarket → excluded
      result('2026-07-20T13:00:00.000Z', 9),  // 09:00–10:00 ET straddles the open → kept
      result('2026-07-20T19:00:00.000Z', 15), // 15:00–16:00 ET regular → kept
      result('2026-07-20T20:00:00.000Z', 16), // 16:00–17:00 ET after-hours → excluded
    ] }));
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-21T14:00:00.000Z'), fetcher as typeof fetch);
    const output = await provider.getBars({ instrument, interval: '1h', range: '1m', adjusted: false, session: 'regular' });
    expect(output.bars.map((bar) => bar.close)).toEqual([9, 15]);
  });

  it('rejects response ticker mismatch and malformed OHLC instead of substituting data', async () => {
    const mismatch = vi.fn(async () => json({ status: 'OK', ticker: 'MSFT', results: [] }));
    await expect(new PolygonMarketDataProvider('secret', undefined, mismatch as typeof fetch).getBars({ instrument, interval: '5m', range: '1d', adjusted: false, session: 'regular' })).rejects.toMatchObject({ code: 'invalid-provider-response' });

    const malformed = vi.fn(async () => json({ status: 'OK', ticker: 'AAPL', results: [{ t: Date.now(), o: 10, h: 5, l: 9, c: 11, v: 100 }] }));
    const output = await new PolygonMarketDataProvider('secret', undefined, malformed as typeof fetch).getBars({ instrument, interval: '5m', range: '1d', adjusted: false, session: 'extended' });
    expect(output.bars).toEqual([]);
    expect(output.warnings[0]).toContain('Rejected invalid Polygon bar');
  });

  it.each([
    // A bare 403 is a plan entitlement boundary (valid key, not permitted): the snapshot
    // forbidden triggers exactly one previous-close fallback attempt (also 403 here) before
    // the truthful forbidden surfaces — two endpoints, each tried once, no internal retry loop.
    [403, {}, 'forbidden', 2],
    [429, { 'retry-after': '17' }, 'rate-limited', 1],
  ] as const)('maps entitlement/rate failures without retry loops (%s)', async (status, headers, code, calls) => {
    const fetcher = vi.fn(async () => json({ message: 'provider rejected request' }, status, headers));
    const provider = new PolygonMarketDataProvider('secret', undefined, fetcher as typeof fetch);
    await expect(provider.getQuote(instrument)).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfterSeconds: 17 } : {}) });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('gates endpoints after a proven entitlement failure for the provider instance', async () => {
    const fetcher = vi.fn(async () => json({ message: 'not entitled' }, 403));
    const provider = new PolygonMarketDataProvider('secret', undefined, fetcher as typeof fetch);
    await expect(provider.getQuote(instrument)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(provider.getQuote({
      ...instrument,
      canonicalSymbol: 'MSFT',
      providerSymbol: 'MSFT',
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back to the free previous-close aggregate when the snapshot quote is not entitled (403)', async () => {
    // Root cause of the production /api/market/quote 403: the premium snapshot endpoint
    // is not entitled. The free previous-close aggregate is, so the quote is served as a
    // truthful end-of-day value for the resolved symbol — real-time is never fabricated.
    const closeTs = Date.parse('2026-07-20T20:00:00.000Z');
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/snapshot/')) return json({ status: 'NOT_AUTHORIZED', message: 'not entitled' }, 403);
      return json({ status: 'OK', ticker: 'AAPL', resultsCount: 1, results: [{ T: 'AAPL', o: 209, h: 214, l: 208, c: 212, v: 5000, t: closeTs }] });
    });
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-21T14:00:00.000Z'), fetcher as typeof fetch);
    await expect(provider.getQuote(instrument)).resolves.toMatchObject({
      symbol: 'AAPL', price: 212, previousClose: null, change: null, changePercent: null,
      status: 'end-of-day', provider: 'polygon', open: 209, high: 214, low: 208, volume: 5000,
    });
  });

  it('derives the fallback daily change from two real daily closes', async () => {
    // Production incident (RKLB): the snapshot is not entitled (403), so the free
    // previous-close aggregate serves the price (69.75). That endpoint alone cannot
    // express a daily change, so the provider now reads the prior session's close
    // from the free daily aggregates and computes change from TWO real closes. The
    // two endpoints date the SAME 2026-07-22 session differently (prev → 20:00Z
    // close, daily → 04:00Z start), so sessions are matched by local calendar date.
    const rklb: ResolvedInstrument = { ...instrument, canonicalSymbol: 'RKLB', providerSymbol: 'RKLB', name: 'Rocket Lab' };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/snapshot/')) return json({ status: 'NOT_AUTHORIZED', message: 'not entitled' }, 403);
      if (url.includes('/range/1/day/')) {
        return json({ status: 'OK', ticker: 'RKLB', results: [
          { T: 'RKLB', o: 66.34, h: 70.0, l: 66.0, c: 69.12, v: 18_000_000, t: Date.parse('2026-07-21T04:00:00.000Z') },
          { T: 'RKLB', o: 70.49, h: 72.94, l: 69.25, c: 69.75, v: 21_031_353, t: Date.parse('2026-07-22T04:00:00.000Z') },
        ] });
      }
      return json({ status: 'OK', ticker: 'RKLB', resultsCount: 1, results: [
        { T: 'RKLB', o: 70.49, h: 72.94, l: 69.25, c: 69.75, v: 21_031_353, t: Date.parse('2026-07-22T20:00:00.000Z') },
      ] });
    });
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-23T14:00:00.000Z'), fetcher as typeof fetch);
    const quote = await provider.getQuote(rklb);
    expect(quote).toMatchObject({ symbol: 'RKLB', price: 69.75, previousClose: 69.12, status: 'end-of-day', provider: 'polygon' });
    expect(quote.change).toBeCloseTo(0.63, 2);
    expect(quote.changePercent).toBeCloseTo(0.9115, 3);
  });

  it('keeps the fallback change null when only one daily close exists (never guesses from OHLC)', async () => {
    // A single available session (new listing / one bar) must NOT infer a change
    // from this bar's own open/high/low. The prior-close lookup returns the same
    // session by date, which is excluded, so change stays null and is hidden.
    const rklb: ResolvedInstrument = { ...instrument, canonicalSymbol: 'RKLB', providerSymbol: 'RKLB' };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/snapshot/')) return json({ status: 'NOT_AUTHORIZED' }, 403);
      if (url.includes('/range/1/day/')) {
        return json({ status: 'OK', ticker: 'RKLB', results: [
          { T: 'RKLB', o: 70.49, h: 72.94, l: 69.25, c: 69.75, v: 21_031_353, t: Date.parse('2026-07-22T04:00:00.000Z') },
        ] });
      }
      return json({ status: 'OK', ticker: 'RKLB', resultsCount: 1, results: [
        { T: 'RKLB', o: 70.49, h: 72.94, l: 69.25, c: 69.75, v: 21_031_353, t: Date.parse('2026-07-22T20:00:00.000Z') },
      ] });
    });
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-23T14:00:00.000Z'), fetcher as typeof fetch);
    await expect(provider.getQuote(rklb)).resolves.toMatchObject({
      symbol: 'RKLB', price: 69.75, previousClose: null, change: null, changePercent: null, status: 'end-of-day',
    });
  });

  it('degrades the fallback change to null when the daily-aggregates lookup fails (best-effort, never fails the quote)', async () => {
    // The prior-close enrichment must never turn a served price into an error: a
    // 500 on the daily endpoint leaves the price intact with the change hidden.
    const rklb: ResolvedInstrument = { ...instrument, canonicalSymbol: 'RKLB', providerSymbol: 'RKLB' };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/snapshot/')) return json({ status: 'NOT_AUTHORIZED' }, 403);
      if (url.includes('/range/1/day/')) return json({ status: 'ERROR' }, 500);
      return json({ status: 'OK', ticker: 'RKLB', resultsCount: 1, results: [
        { T: 'RKLB', o: 70.49, h: 72.94, l: 69.25, c: 69.75, v: 21_031_353, t: Date.parse('2026-07-22T20:00:00.000Z') },
      ] });
    });
    const provider = new PolygonMarketDataProvider('secret', () => new Date('2026-07-23T14:00:00.000Z'), fetcher as typeof fetch);
    await expect(provider.getQuote(rklb)).resolves.toMatchObject({
      symbol: 'RKLB', price: 69.75, previousClose: null, change: null, changePercent: null, status: 'end-of-day',
    });
  });

  it('never returns another symbol from the previous-close fallback', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/snapshot/')) return json({ status: 'NOT_AUTHORIZED' }, 403);
      // A mismatched ticker in the aggregate response must be rejected, not surfaced.
      return json({ status: 'OK', ticker: 'MSFT', results: [{ T: 'MSFT', o: 1, h: 1, l: 1, c: 1, v: 1, t: Date.now() }] });
    });
    const provider = new PolygonMarketDataProvider('secret', undefined, fetcher as typeof fetch);
    await expect(provider.getQuote(instrument)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('normalizes provider market status by the resolved exchange', async () => {
    const fetcher = vi.fn(async () => json({ market: 'open', serverTime: '2026-07-20T14:00:00.000Z', exchanges: { nasdaq: 'open', nyse: 'open', otc: 'closed' }, earlyHours: false, afterHours: false }));
    const session = await new PolygonMarketDataProvider('secret', () => new Date('2026-07-20T14:01:00.000Z'), fetcher as typeof fetch).getSession(instrument);
    expect(session).toMatchObject({ status: 'open', exchange: 'NASDAQ', timezone: 'America/New_York', provider: 'polygon', source: 'polygon-market-status', stale: false });
  });
});
