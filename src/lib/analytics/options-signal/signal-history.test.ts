import { describe, expect, it } from 'vitest';
import { ivPercentilePendingOf } from './assemble';
import { calculateOptionsSignal } from './calculations';
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_CONFIG_VERSION } from './config';
import {
  buildSignalHistoryRecord,
  createResilientHistoryStore,
  createSignalHistoryLog,
  readOwnHistory,
  recordOptionsSignal,
  type OptionsSignalHistoryPoint,
  type OptionsSignalHistoryRecord,
  type OptionsSignalHistoryStore,
} from './signal-history';
import type {
  EventRiskInput,
  IvPricingInput,
  MacroInput,
  MomentumInput,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  RiskRewardInput,
  SentimentInput,
  TrendInput,
} from './types';

/**
 * The store behind the two percentile bases.
 *
 * These rules are what decide whether the IV percentile and the Put/Call
 * percentile are a feature or dead code: both need sixty of a symbol's own
 * readings, and a reading only counts if it survives a deploy.
 */

const AS_OF = '2026-08-19T01:43:00.000Z';

function available<T>(
  value: T,
  state: 'LIVE' | 'DELAYED' | 'STALE' = 'DELAYED',
  asOf: string | null = AS_OF,
  provider = 'fixture',
): OptionsSignalInputSlot<T> {
  return { status: 'available', state, value, provider, asOf };
}

const cheapIv: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.24, realizedVolatility: 0.32, ratio: 0.75,
  observations: 250, realizedWindowDays: 252, dte: 55,
};
const neutralSentiment: SentimentInput = {
  putCallRatio: 0.9, basis: 'open-interest', putTotal: 9_000, callTotal: 10_000, expiration: '2026-09-18',
};

function input(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-08-19T02:00:00.000Z',
    latestCandleAt: '2026-08-18',
    finalizedCandles: 250,
    macro: available<MacroInput>({
      benchmarks: [
        { symbol: 'SPY', close: 500, ema20: 480 },
        { symbol: 'QQQ', close: 400, ema20: 390 },
      ],
    }),
    trend: available<TrendInput>({ close: 110, ema20: 105, ema50: 100 }),
    momentum: available<MomentumInput>({ squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 }),
    pricing: available<IvPricingInput>(cheapIv),
    sentiment: available(neutralSentiment),
    riskReward: available<RiskRewardInput>({ price: 110, support: 105, resistance: 130, atr: 3 }),
    event: available<EventRiskInput>({ reportDate: '2026-09-20', daysToEarnings: 28, timeOfDay: 'post-market' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// New 3. history
// ---------------------------------------------------------------------------

describe('signal history stores every computation with its inputs and config version', () => {
  it('keeps the whole input and stamps the config revision', () => {
    const source = input();
    const result = calculateOptionsSignal(source);
    const record = buildSignalHistoryRecord(source, result, '2026-08-19T02:00:00.000Z');
    expect(record.configVersion).toBe(OPTIONS_SIGNAL_CONFIG_VERSION);
    expect(record.input).toEqual(source);
    expect(record.score).toBe(result.status === 'available' ? result.directionScore0to100 : null);
    expect(record.iv).toBe(0.24);
    expect(record.putCallOi).toBe(0.9);
    // The finalized-candle date, never the write date: two readings either side
    // of a session close are different days, and keying on "now" would lose one.
    expect(record.capturedAt).toBe('2026-08-18');
  });

  it('is bounded, so a long-lived process cannot grow one', async () => {
    const log = createSignalHistoryLog(3);
    const source = input();
    const result = calculateOptionsSignal(source);
    for (let index = 0; index < 10; index += 1) {
      await recordOptionsSignal(source, result, log, { now: () => new Date(Date.UTC(2026, 7, index + 1)) });
    }
    expect(log.all()).toHaveLength(3);
  });

  it('serves one reading per captured date back as the symbol’s own history', async () => {
    const log = createSignalHistoryLog();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const [day, iv] of [[yesterday, 0.2], [today, 0.24], [today, 0.26]] as const) {
      const source = input({
        latestCandleAt: day,
        pricing: available<IvPricingInput>({ ...cheapIv, impliedVolatility: iv }),
      });
      await recordOptionsSignal(source, calculateOptionsSignal(source), log);
    }
    // Three writes, two days: the later reading for a day replaces the earlier.
    expect(log.all()).toHaveLength(3);
    expect((await readOwnHistory('TEST', log)).atmIv).toEqual([0.2, 0.26]);
  });

  it('never throws, whatever it is handed', async () => {
    const log = createSignalHistoryLog();
    await expect(recordOptionsSignal(
      input(),
      calculateOptionsSignal(input({ finalizedCandles: 1 })),
      log,
    )).resolves.not.toThrow();
  });
});

/**
 * The durable half. The percentile bases are only reachable because a reading
 * survives a deploy, so the rules below are what decide whether D and E are a
 * feature or dead code.
 */
describe('history falls back to the buffer on an outage, never on an empty answer', () => {
  const point = (capturedAt: string, iv: number): OptionsSignalHistoryPoint => ({
    capturedAt, configVersion: OPTIONS_SIGNAL_CONFIG_VERSION, iv, putCallOi: 1.1, putCallVolume: null,
  });

  const stub = (
    read: OptionsSignalHistoryStore['read'],
    writes: OptionsSignalHistoryRecord[] = [],
  ): OptionsSignalHistoryStore => ({
    read,
    async write(record) { writes.push(record); return true; },
  });

  it('prefers the durable answer, even when the durable answer is empty', async () => {
    const fallback = createSignalHistoryLog();
    const source = input();
    await recordOptionsSignal(source, calculateOptionsSignal(source), fallback);

    // A symbol nobody has opened before genuinely has no history. Substituting
    // this instance’s own views would build a "sixty-day" percentile out of one
    // afternoon, which is exactly the misreading the percentile exists to stop.
    const resilient = createResilientHistoryStore(stub(async () => []), fallback);
    expect(await resilient.read('TEST', 180)).toEqual([]);
    expect((await readOwnHistory('TEST', resilient)).atmIv).toEqual([]);
  });

  it('falls back when the durable store cannot answer', async () => {
    const fallback = createSignalHistoryLog();
    const source = input();
    await recordOptionsSignal(source, calculateOptionsSignal(source), fallback);

    const resilient = createResilientHistoryStore(stub(async () => null), fallback);
    expect((await readOwnHistory('TEST', resilient)).atmIv).toEqual([0.24]);
  });

  it('falls back when the durable store throws outright', async () => {
    const fallback = createSignalHistoryLog();
    const source = input();
    await recordOptionsSignal(source, calculateOptionsSignal(source), fallback);

    const resilient = createResilientHistoryStore(
      stub(async () => { throw new Error('connection reset'); }),
      fallback,
    );
    expect((await readOwnHistory('TEST', resilient)).atmIv).toEqual([0.24]);
  });

  it('writes to both, so an instance that later loses the database keeps its own readings', async () => {
    const durableWrites: OptionsSignalHistoryRecord[] = [];
    const fallback = createSignalHistoryLog();
    const resilient = createResilientHistoryStore(stub(async () => [], durableWrites), fallback);

    const source = input();
    await recordOptionsSignal(source, calculateOptionsSignal(source), resilient);
    expect(durableWrites).toHaveLength(1);
    expect(fallback.all()).toHaveLength(1);
  });

  it('reaches sixty readings, which is the whole point of making it durable', async () => {
    const days = Array.from({ length: 60 }, (_value, index) => {
      const date = new Date(Date.UTC(2026, 4, 1) + index * 86_400_000);
      return point(date.toISOString().slice(0, 10), 0.2 + index * 0.001);
    });
    const resilient = createResilientHistoryStore(stub(async () => days), createSignalHistoryLog());
    const own = await readOwnHistory('TEST', resilient);
    expect(own.atmIv).toHaveLength(60);
    expect(own.putCallRatio).toHaveLength(60);
    // 60 is the threshold at which the card stops counting down and publishes.
    expect(own.atmIv?.length ?? 0).toBeGreaterThanOrEqual(OPTIONS_SIGNAL_CONFIG.iv.minimumPercentileObservations);
    expect(ivPercentilePendingOf(own.atmIv)).toBeNull();
  });

  it('drops readings from another config revision when asked to', async () => {
    const mixed: OptionsSignalHistoryPoint[] = [
      { ...point('2026-06-01', 0.2), configVersion: '2020.01.01' },
      point('2026-06-02', 0.3),
    ];
    const resilient = createResilientHistoryStore(stub(async () => mixed), createSignalHistoryLog());
    expect((await readOwnHistory('TEST', resilient)).atmIv).toEqual([0.2, 0.3]);
    expect((await readOwnHistory('TEST', resilient, { configVersion: OPTIONS_SIGNAL_CONFIG_VERSION })).atmIv)
      .toEqual([0.3]);
  });

  it('never lets a history failure become a page failure', async () => {
    const broken: OptionsSignalHistoryStore = {
      async read() { throw new Error('down'); },
      async write() { throw new Error('down'); },
    };
    const resilient = createResilientHistoryStore(broken, createSignalHistoryLog());
    await expect(readOwnHistory('TEST', resilient)).resolves.toEqual({ atmIv: [], putCallRatio: [] });
    await expect(recordOptionsSignal(input(), calculateOptionsSignal(input()), resilient))
      .resolves.not.toBeNull();
  });
});
