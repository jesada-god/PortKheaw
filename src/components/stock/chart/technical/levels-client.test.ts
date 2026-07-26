import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearChartLevelsCache,
  levelBasisInterval,
  levelsRequestKey,
  requestChartLevels,
  type LevelsFetcher,
} from './levels-client';

function levelsResponse(sourceTime = 1_700_000_000): Response {
  return new Response(JSON.stringify({
    data: {
      symbol: 'AAPL',
      basisInterval: '1D',
      sourceTime,
      provider: 'yahoo-finance-chart',
      pivot: 100,
      support: [99, 98, 97],
      resistance: [101, 102, 103],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => clearChartLevelsCache());
afterEach(() => {
  clearChartLevelsCache();
  vi.restoreAllMocks();
});

describe('chart levels request identity', () => {
  it('keys on the pivot basis and ignores the displayed history range', () => {
    // The levels come from the last completed daily/weekly bar, so the range is
    // not an input. Including it would fork the cache for an identical result.
    expect(levelsRequestKey('AAPL', '1D')).toBe(levelsRequestKey('aapl', '5m'));
    expect(levelsRequestKey('AAPL', 'Week')).not.toBe(levelsRequestKey('AAPL', '1D'));
    expect(levelBasisInterval('Week')).toBe('Week');
    expect(levelBasisInterval('15m')).toBe('1D');
  });
});

describe('requestChartLevels', () => {
  it('serves a repeat from cache, so a range change costs zero level requests', async () => {
    const fetcher = vi.fn<LevelsFetcher>(async () => levelsResponse());
    const first = await requestChartLevels({ symbol: 'AAPL', interval: '1D', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('timeframe=1D');

    // 6M → 12 เดือน → 5Y: the chart surface remounts each time and asks again.
    await requestChartLevels({ symbol: 'AAPL', interval: '1D', fetcher });
    await requestChartLevels({ symbol: 'AAPL', interval: '1D', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.pivot).toBe(100);

    // An interval on the same basis reuses it too (5m and 1D both pivot on D1).
    await requestChartLevels({ symbol: 'AAPL', interval: '5m', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A different basis is a genuinely different calculation.
    await requestChartLevels({ symbol: 'AAPL', interval: 'Week', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain('timeframe=Week');
  });

  it('collapses concurrent identical requests onto one network call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<LevelsFetcher>(async () => { await gate; return levelsResponse(); });
    const all = Promise.all([
      requestChartLevels({ symbol: 'NVTS', interval: '1D', fetcher }),
      requestChartLevels({ symbol: 'NVTS', interval: '1D', fetcher }),
      requestChartLevels({ symbol: 'NVTS', interval: '30m', fetcher }),
    ]);
    release();
    const results = await all;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item.pivot)).toEqual([100, 100, 100]);
  });

  it('surfaces the provider message and does not spin a retry loop on failure', async () => {
    const fetcher = vi.fn<LevelsFetcher>(async () => new Response(JSON.stringify({
      data: null,
      error: { message: 'No completed 1D bar is available for classic pivot levels' },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestChartLevels({ symbol: 'RKLB', interval: '1D', fetcher }))
      .rejects.toThrow('No completed 1D bar');
    // The error cooldown absorbs the immediate remount instead of re-requesting.
    await expect(requestChartLevels({ symbol: 'RKLB', interval: '1D', fetcher }))
      .rejects.toThrow('No completed 1D bar');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a payload that fails validation rather than drawing an unverified level', async () => {
    const fetcher = vi.fn<LevelsFetcher>(async () => new Response(JSON.stringify({
      data: { symbol: 'AAPL', pivot: 'not-a-number' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(requestChartLevels({ symbol: 'AAPL', interval: '1D', fetcher }))
      .rejects.toThrow('ไม่ผ่านการตรวจสอบ');
  });
});
