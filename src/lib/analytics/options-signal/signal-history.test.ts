import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ivPercentilePendingOf } from './assemble';
import { calculateOptionsSignal } from './calculations';
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_CONFIG_VERSION } from './config';
import {
  buildSignalHistoryRecord,
  checkHistoryAccess,
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
    // Put/Call is a provider measurement no threshold change moves, so the
    // default keeps every revision of it and the switch is what narrows it.
    expect((await readOwnHistory('TEST', resilient)).putCallRatio).toEqual([1.1, 1.1]);
    expect((await readOwnHistory('TEST', resilient, { configVersion: OPTIONS_SIGNAL_CONFIG_VERSION })).putCallRatio)
      .toEqual([1.1]);
  });

  /*
   * The IV series is narrower than the switch above, and always.
   *
   * Moving the ATM IV onto the horizon expiration changed WHICH CONTRACT the
   * number describes — often a two-day one carrying an earnings report whole,
   * against a forty-four-day one that amortises it. Ranking today's reading
   * against a series of the older kind would rank a stock against an instrument
   * it never traded, so the cutoff applies whether or not a caller asked for the
   * version filter.
   */
  it('never ranks a horizon IV against readings taken off the front chain', async () => {
    const cutoff = OPTIONS_SIGNAL_CONFIG.iv.horizonBasisFromConfigVersion;
    const mixed: OptionsSignalHistoryPoint[] = [
      { ...point('2026-06-01', 0.2), configVersion: '2020.01.01' },
      { ...point('2026-06-02', 0.25), configVersion: '2026.08.19b' },
      { ...point('2026-06-03', 0.3), configVersion: cutoff },
      { ...point('2026-06-04', 0.35), configVersion: '2026.09.01' },
    ];
    const resilient = createResilientHistoryStore(stub(async () => mixed), createSignalHistoryLog());
    const own = await readOwnHistory('TEST', resilient);
    // The cutoff version itself is IN, and so is everything after it: a later
    // unrelated bump must not throw the series away and restart the countdown.
    expect(own.atmIv).toEqual([0.3, 0.35]);
    // And the Put/Call series, which that change did not touch, keeps all four.
    expect(own.putCallRatio).toHaveLength(4);
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

/**
 * The silent-denial case.
 *
 * `public.options_signal_history` has RLS on with no policy — that IS the
 * entitlement boundary and it must stay. The cost is a failure mode that looks
 * exactly like success: under a key that is not the service role, PostgREST
 * answers a SELECT with an empty set rather than an error, and an empty set is
 * also the right answer for a symbol nobody has opened. A read alone cannot tell
 * them apart, so an unreachable store would park every symbol on a 60-day
 * countdown that never moves.
 */
describe('a store that silently returns nothing is caught, not believed', () => {
  const today = () => new Date('2026-08-19T09:00:00.000Z');

  /*
   * THE OTHER CLOCK IN THIS TEST, which `now:` does not reach.
   *
   * `checkHistoryAccess` takes its clock as an option and every case below
   * passes it, so the probe row is captured on 2026-08-19. The store it probes
   * has a clock of its own: `createSignalHistoryLog().read()` computes its
   * lookback cutoff from `Date.now()`, which is the REAL day. Once the real day
   * moved more than `lookbackDays` past 2026-08-19, the probe's own row fell
   * outside the window it was read back through — so the row was written, could
   * not be seen, and the canary reported `history-read-denied-silently` on a
   * store that was working perfectly. A false outage, arriving on a date rather
   * than on a change.
   *
   * Pinning `Date` here puts the store's clock on the same day as the injected
   * one. The fix is in the test and not in the store on purpose: the store's
   * `Date.now()` is correct for the process it runs in, and giving it an
   * injectable clock is a source change this round is not allowed to make. It
   * is written up in `docs/market-signal/open-work.md`.
   *
   * Scoped to this describe. The blocks above deliberately read the real today
   * (`new Date().toISOString()`) to check same-day upsert behaviour, and those
   * are true on any day.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(today());
  });

  afterEach(() => vi.useRealTimers());

  /** RLS denial as PostgREST actually presents it: writes rejected, reads empty. */
  function rlsDeniedStore(): OptionsSignalHistoryStore {
    return {
      async read() { return []; },
      async write() { return false; },
    };
  }

  /** The nastier shape: the write appears to land, but nothing can be read back. */
  function writeOnlyStore(): OptionsSignalHistoryStore {
    return {
      async read() { return []; },
      async write() { return true; },
    };
  }

  it('reports an outage when the write is rejected', async () => {
    const health = await checkHistoryAccess(rlsDeniedStore(), { now: today });
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('history-write-rejected');
  });

  it('reports an outage when the row it just wrote cannot be read back', async () => {
    // This is the exact silent shape: no error anywhere, and still broken.
    const health = await checkHistoryAccess(writeOnlyStore(), { now: today });
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('history-read-denied-silently');
  });

  it('reports an outage when the read cannot answer at all', async () => {
    const health = await checkHistoryAccess({
      async read() { return null; },
      async write() { return true; },
    }, { now: today });
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('history-read-failed');
  });

  it('does not turn a thrown probe into a healthy verdict', async () => {
    const health = await checkHistoryAccess({
      async read() { throw new Error('connection reset'); },
      async write() { return true; },
    }, { now: today });
    expect(health.ok).toBe(false);
    expect(health.reason).toContain('history-probe-threw');
  });

  it('passes on a store that can actually round-trip a row', async () => {
    const log = createSignalHistoryLog();
    const health = await checkHistoryAccess(log, { now: today });
    expect(health.ok).toBe(true);
    expect(health.reason).toBeNull();
  });

  it('probes with an EMPTY input, never a null one', async () => {
    /*
     * `inputs` is `jsonb not null` in the migration. A null probe row is a 23502
     * the moment it reaches Postgres, and the health check reads its own
     * rejected write as "the store is unreachable" — which is how a healthy
     * table came to be reported as an outage on every card.
     */
    const log = createSignalHistoryLog();
    await checkHistoryAccess(log, { now: today });
    const probe = log.all().at(-1);
    expect(probe?.input).not.toBeNull();
    expect(probe?.input).toBeTypeOf('object');
  });

  it('says WHY the store refused, in the store own words, not just THAT it did', async () => {
    const rejecting: OptionsSignalHistoryStore = {
      async write() { return false; },
      async read() { return []; },
      lastFailure: () => ({
        operation: 'write',
        code: '23502',
        message: 'null value in column "inputs" violates not-null constraint',
        hint: null,
        details: null,
      }),
    };
    const health = await checkHistoryAccess(rejecting, { now: today });
    expect(health.ok).toBe(false);
    // The slug survives for anything that greps on it, and the sentence that
    // actually names the broken column rides along behind it.
    expect(health.reason).toContain('history-write-rejected');
    expect(health.reason).toContain('23502');
    expect(health.reason).toContain('inputs');
  });

  it('still reports a bare reason for a store that keeps no failure', async () => {
    const mute: OptionsSignalHistoryStore = {
      async write() { return false; },
      async read() { return []; },
    };
    expect((await checkHistoryAccess(mute, { now: today })).reason).toBe('history-write-rejected');
  });

  it('writes its probe under the reserved symbol, never under a real one', async () => {
    const log = createSignalHistoryLog();
    await checkHistoryAccess(log, { now: today });
    const symbols = new Set(log.all().map((entry) => entry.symbol));
    expect([...symbols]).toEqual([OPTIONS_SIGNAL_CONFIG.history.canarySymbol]);
    // And that symbol satisfies the table's own check constraint.
    expect(OPTIONS_SIGNAL_CONFIG.history.canarySymbol).toMatch(/^[A-Z0-9][A-Z0-9.-]{0,19}$/);
  });

  it('leaves an empty-but-healthy store reading as empty, not as an outage', async () => {
    // The distinction the whole design turns on: a new symbol has no history and
    // that is not a failure.
    const log = createSignalHistoryLog();
    expect((await checkHistoryAccess(log, { now: today })).ok).toBe(true);
    expect((await readOwnHistory('NEVER-OPENED', log)).atmIv).toEqual([]);
  });
});

describe('an outage is shown as an outage, never as a countdown', () => {
  it('withholds the countdown and says the store is unreachable instead', () => {
    const degraded = calculateOptionsSignal(input({
      ivPercentilePending: { observations: 12, required: 60, missingDays: 48 },
      historyDegraded: true,
    }));
    expect(degraded.historyDegraded).toBe(true);
    expect(degraded.diagnostics.iv.percentileStoreUnavailable).toBe(true);
    // The countdown is suppressed: it would be counting down to nothing.
    expect(degraded.diagnostics.iv.percentilePending).toBeNull();
    expect(degraded.reasoning.some((reason) => reason.id === 'iv-percentile-pending')).toBe(false);
    const outage = degraded.reasoning.find((reason) => reason.id === 'history-unavailable');
    expect(outage?.polarity).toBe('caution');
    expect(outage?.text).toContain('ชั่วคราว');
  });

  it('keeps showing the countdown when the store is merely young', () => {
    const accumulating = calculateOptionsSignal(input({
      ivPercentilePending: { observations: 12, required: 60, missingDays: 48 },
    }));
    expect(accumulating.historyDegraded).toBe(false);
    expect(accumulating.diagnostics.iv.percentileStoreUnavailable).toBe(false);
    expect(accumulating.diagnostics.iv.percentilePending?.missingDays).toBe(48);
    expect(accumulating.reasoning.some((reason) => reason.id === 'history-unavailable')).toBe(false);
    expect(accumulating.reasoning.some((reason) => reason.id === 'iv-percentile-pending')).toBe(true);
  });

  it('carries no counter anywhere in the card when the store is unreachable', () => {
    /*
     * The failure this test exists for: the card-level notice said "outage" while
     * the Options Sentiment factor, one line below it, still said
     * "มีประวัติ 0/20 วัน" — the countdown's own words, for a countdown that was
     * not running. A reader gets both sentences at once, so BOTH have to come
     * from the same state, and the check is over every string the result
     * publishes rather than over the one that happened to be wrong.
     */
    const degraded = calculateOptionsSignal(input({
      historyDegraded: true,
      sentiment: available<SentimentInput>({
        ...neutralSentiment,
        putCallRatio: 1.51,
        ownPercentile: null,
        percentileObservations: 0,
      }),
      ivPercentilePending: { observations: 0, required: 60, missingDays: 60 },
    }));
    expect(degraded.historyDegraded).toBe(true);

    const published = [
      ...degraded.reasoning.map((reason) => reason.text),
      ...Object.values(degraded.diagnostics.factors).map((factor) => factor.detail),
    ];
    for (const text of published) {
      // No "n/m วัน", no "0/20", no denominator of any shape.
      expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
      expect(text).not.toMatch(/มีประวัติ\s*\d/);
      expect(text).not.toMatch(/ต้องการข้อมูลอีก\s*\d/);
    }
    // And it still says what IS wrong, on the factor as well as on the card.
    expect(degraded.diagnostics.factors.sentiment.detail).toContain('อ่านประวัติ');
    expect(degraded.diagnostics.factors.sentiment.detail).toContain('ชั่วคราว');
  });

  it('keeps the counter on the sentiment factor while the store is merely young', () => {
    const young = calculateOptionsSignal(input({
      sentiment: available<SentimentInput>({
        ...neutralSentiment,
        putCallRatio: 1.51,
        ownPercentile: null,
        percentileObservations: 4,
      }),
    }));
    expect(young.historyDegraded).toBe(false);
    expect(young.diagnostics.factors.sentiment.detail)
      .toContain(`มีประวัติ 4/${OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations} วัน`);
  });

  it('never lets the two states be true at once', () => {
    for (const degraded of [true, false]) {
      const result = calculateOptionsSignal(input({
        ivPercentilePending: { observations: 3, required: 60, missingDays: 57 },
        historyDegraded: degraded,
      }));
      const showsCountdown = result.diagnostics.iv.percentilePending !== null;
      const showsOutage = result.diagnostics.iv.percentileStoreUnavailable;
      expect(showsCountdown && showsOutage).toBe(false);
    }
  });
});
