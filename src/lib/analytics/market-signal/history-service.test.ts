import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataFreshness } from '@/src/lib/market-data/types';
import type { MarketSignalCandle, MarketSignalHistoryEntry } from './types';

/**
 * The P6 rollout contract, checked at the layer that owns it.
 *
 * `SIGNAL_HISTORY` off has to mean the database is never touched — not that the
 * field is dropped afterwards. A flag that still issues the query is a flag that
 * still costs a round trip and still writes rows, which is not what "off" means
 * to anybody reading the rollout plan.
 */

vi.mock('server-only', () => ({}));

const readSignalHistory = vi.fn<(symbol: string, windowDays: number) => Promise<MarketSignalHistoryEntry[]>>();
const writeSignalSnapshot = vi.fn<(snapshot: unknown) => Promise<void>>();

vi.mock('./history-repository', () => ({
  readSignalHistory: (...args: [string, number]) => readSignalHistory(...args),
  writeSignalSnapshot: (...args: [unknown]) => writeSignalSnapshot(...args),
}));

const frozen = JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', 'IREN.json'), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

vi.mock('@/src/lib/market-data/candles', () => ({
  getCandleMarketDataService: () => ({
    getCandles: async () => ({
      provider: frozen.source,
      freshness: frozen.freshness,
      data: {
        provider: frozen.source,
        candles: frozen.candles.map((candle) => ({
          timestamp: Date.parse(`${candle.date}T00:00:00Z`) / 1000,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume ?? 0,
          partial: candle.finalized !== true,
        })),
      },
    }),
  }),
}));

const { loadMarketSignal } = await import('./service');

const entry = (asOf: string, state: 'SIDEWAYS' | 'BULLISH'): MarketSignalHistoryEntry => ({
  asOf, state, rawState: state, bias: 'neutral', zone: 'sideways', score: 3, evidenceAgreement: 60, flags: [],
});

beforeEach(() => {
  readSignalHistory.mockReset().mockResolvedValue([]);
  writeSignalSnapshot.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.SIGNAL_HISTORY;
});

describe('with SIGNAL_HISTORY off', () => {
  it('never reads and never writes', async () => {
    const result = await loadMarketSignal('IREN');
    expect(readSignalHistory).not.toHaveBeenCalled();
    expect(writeSignalSnapshot).not.toHaveBeenCalled();
    expect('history' in result).toBe(false);
  });

  it('raises no recent_flip flag, because it has nothing to compare against', async () => {
    const result = await loadMarketSignal('IREN');
    expect(result.flags).not.toContain('recent_flip');
  });
});

describe('with SIGNAL_HISTORY on', () => {
  beforeEach(() => { process.env.SIGNAL_HISTORY = 'true'; });

  it('records the day and hands back the strip', async () => {
    const result = await loadMarketSignal('IREN');
    expect(writeSignalSnapshot).toHaveBeenCalledTimes(1);
    expect(result.history).toBeDefined();
    expect(result.history!.windowDays).toBe(30);
  });

  /*
   * Today's reading has to be IN the strip — it is the newest thing the card
   * has said, and a strip whose last cell is yesterday would show a label
   * changing one day late for every reader who looked before the close.
   */
  it('includes today in the strip rather than only what was already stored', async () => {
    readSignalHistory.mockResolvedValue([entry('2020-01-01', 'SIDEWAYS')]);
    const result = await loadMarketSignal('IREN');
    expect(result.status).toBe('available');
    const newest = result.history!.entries.at(-1)!;
    expect(newest.asOf).toBe(result.latestCandleAt);
    expect(newest.state).toBe(result.state);
    // And the stored day is still there underneath it.
    expect(result.history!.entries[0].asOf).toBe('2020-01-01');
  });

  it('does not file today twice when a row for it already exists', async () => {
    const first = await loadMarketSignal('IREN');
    const today = first.history!.entries.at(-1)!;
    readSignalHistory.mockResolvedValue([today]);

    const second = await loadMarketSignal('IREN');
    const dates = second.history!.entries.map((item) => item.asOf);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('raises recent_flip when a different label was recorded within the window', async () => {
    const first = await loadMarketSignal('IREN');
    const today = first.history!.entries.at(-1)!;
    const yesterday = new Date(Date.parse(`${today.asOf}T00:00:00Z`) - 86_400_000)
      .toISOString().slice(0, 10);
    readSignalHistory.mockResolvedValue([
      entry(yesterday, today.state === 'BULLISH' ? 'SIDEWAYS' : 'BULLISH'),
    ]);

    const result = await loadMarketSignal('IREN');
    expect(result.history!.recentFlip).toBe(true);
    expect(result.flags).toContain('recent_flip');
  });

  /*
   * The history is decoration on a card that has to render without it. A read
   * that throws must cost the strip and nothing else.
   */
  it('still returns the FULL card when the store is unreachable', async () => {
    readSignalHistory.mockRejectedValue(new Error('no database'));
    const result = await loadMarketSignal('IREN');
    // Not merely "a card": the reading was already computed correctly, and a
    // failed strip must not turn it into an insufficient-data placeholder.
    expect(result.status).toBe('available');
    expect(result.history).toBeUndefined();
  });

  it('still returns the full card when the write fails', async () => {
    writeSignalSnapshot.mockRejectedValue(new Error('read-only replica'));
    const result = await loadMarketSignal('IREN');
    expect(result.status).toBe('available');
  });
});
