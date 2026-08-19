import 'server-only';

import { serverEnv } from '@/src/config/env/server';
import { MarketDataError } from '@/src/lib/market-data/errors';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { nextEarnings } from './normalize';
import {
  loadAlphaVantageEarnings,
  loadFinancialModelingPrepEarnings,
  type EarningsProviderResponse,
} from './providers';
import {
  EARNINGS_SCHEDULE_TTL_MS,
  entryFromSchedule,
  isFreshEarningsEntry,
  isUsableEarningsFallback,
  scheduleFromEntry,
  type EarningsScheduleStore,
} from './schedule-cache';
import { getEarningsScheduleStore } from './schedule-repository';
import type {
  EarningsProviderId,
  EarningsSchedule,
  EarningsUnavailableReason,
} from './types';

/**
 * The earnings calendar changes at most once a quarter per symbol, so it is
 * cached hard. `staleMs` deliberately outlives `freshMs` by a week: an expired
 * provider key must degrade to a truthfully-flagged stale date, never to a
 * silent "no earnings scheduled".
 */
const CACHE_POLICY = {
  freshMs: 12 * 60 * 60_000,
  staleMs: 7 * 24 * 60 * 60_000,
  errorMs: 10 * 60_000,
} as const;

const sharedCache = new SharedRequestCache();

export interface LoadEarningsScheduleOptions {
  alphaVantageApiKey?: string | null;
  fmpApiKey?: string | null;
  fetcher?: typeof fetch;
  now?: () => number;
  cache?: SharedRequestCache;
  signal?: AbortSignal;
  /**
   * The durable last-known-good calendar. Injected so a test can hand in a
   * store with a known row and then break the providers, which is the one
   * scenario this whole path exists for.
   */
  store?: EarningsScheduleStore;
  /** Overridable only so a test does not have to move the clock a day. */
  ttlMs?: number;
}

function reasonFor(error: unknown): EarningsUnavailableReason {
  if (error instanceof MarketDataError) {
    if (error.code === 'forbidden' || error.code === 'provider-unauthorized') return 'entitlement-unavailable';
    if (error.code === 'rate-limited') return 'rate-limited';
    // A parseable-but-wrong payload is a distinct fault from an outage: it must
    // not be retried the same way, and it is never "no report scheduled".
    if (error.code === 'invalid-provider-response') return 'invalid-response';
  }
  return 'provider-unavailable';
}

const MESSAGES: Record<EarningsUnavailableReason, string> = {
  'not-configured': 'ยังไม่ได้ตั้งค่าผู้ให้บริการปฏิทินงบการเงินบนเซิร์ฟเวอร์',
  'no-scheduled-report': 'ผู้ให้บริการยังไม่ประกาศวันประกาศงบครั้งถัดไป',
  'entitlement-unavailable': 'แพ็กเกจของผู้ให้บริการไม่รองรับปฏิทินงบการเงิน',
  'rate-limited': 'ผู้ให้บริการจำกัดจำนวนคำขอชั่วคราว',
  'invalid-response': 'ผู้ให้บริการส่งข้อมูลปฏิทินงบการเงินในรูปแบบที่อ่านไม่ได้',
  'provider-unavailable': 'ดึงวันประกาศงบจากผู้ให้บริการไม่สำเร็จ',
};

/**
 * Next scheduled earnings report for `symbol`.
 *
 * Alpha Vantage's symbol-filtered calendar is primary because it also dates the
 * session (pre/post market); Financial Modeling Prep is the deterministic
 * secondary. Both are real, entitled endpoints.
 *
 * A LAST-KNOWN-GOOD date sits in front of and behind that chain, for the reason
 * written out in `schedule-cache.ts`: this is the only Options Signal input
 * whose disappearance IMPROVES the published numbers, because event risk is a
 * confidence penalty rather than a scored factor. In front, a date fetched
 * within the last 24 hours is served without calling anybody — an earnings date
 * moves about four times a year and the primary provider's key allows 25
 * requests a day in total. Behind, a date that is already known is re-served
 * when both providers refuse, disclosed as STALE, and the penalty it carries
 * stays exactly where it was.
 *
 * Only a symbol NOBODY has ever successfully fetched still reports unavailable.
 */
export async function loadEarningsSchedule(
  rawSymbol: string,
  options: LoadEarningsScheduleOptions = {},
): Promise<EarningsSchedule> {
  const symbol = rawSymbol.trim().toUpperCase();
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedCache;
  const store = options.store ?? getEarningsScheduleStore();
  const ttlMs = options.ttlMs ?? EARNINGS_SCHEDULE_TTL_MS;
  const alphaVantageApiKey = options.alphaVantageApiKey ?? serverEnv.ALPHA_VANTAGE_API_KEY ?? null;
  const fmpApiKey = options.fmpApiKey ?? serverEnv.FMP_API_KEY ?? null;
  const nowIso = new Date(now()).toISOString();
  // Earnings dates are published as US exchange-local dates, so "today" must be
  // resolved in America/New_York; a Bangkok-local date is up to a day ahead.
  const today = exchangeSessionDate(nowIso, US_EQUITY_TIMEZONE) ?? nowIso.slice(0, 10);

  /*
   * Read once, used twice: as the cheap path when it is fresh, and as the
   * fallback when the chain below comes back empty-handed. A store that cannot
   * answer returns null and every branch below behaves as it did before this
   * cache existed.
   */
  const remembered = await store.read(symbol).catch(() => null);
  if (isFreshEarningsEntry(remembered, today, now(), ttlMs)) {
    return scheduleFromEntry(remembered, today, { stale: false });
  }

  const unavailable = (reason: EarningsUnavailableReason, provider: EarningsProviderId | null): EarningsSchedule => {
    /*
     * The whole point. A date this product already knows is not withdrawn
     * because a provider stopped answering — it is re-published as STALE so the
     * event-risk penalty is applied to the same date it was applied to
     * yesterday. Data going missing must never be able to improve a score.
     */
    if (isUsableEarningsFallback(remembered, today)) {
      return scheduleFromEntry(remembered, today, { stale: true });
    }
    return {
      status: 'unavailable',
      symbol,
      reason,
      message: MESSAGES[reason],
      provider,
      asOf: nowIso,
    };
  };

  const chain: Array<{ id: EarningsProviderId; apiKey: string | null; load: () => Promise<EarningsProviderResponse> }> = [
    {
      id: 'alpha-vantage',
      apiKey: alphaVantageApiKey,
      load: () => loadAlphaVantageEarnings({
        symbol, apiKey: alphaVantageApiKey!, fetcher: options.fetcher, signal: options.signal,
      }),
    },
    {
      id: 'financial-modeling-prep',
      apiKey: fmpApiKey,
      load: () => loadFinancialModelingPrepEarnings({
        symbol, apiKey: fmpApiKey!, fetcher: options.fetcher, signal: options.signal,
      }),
    },
  ];

  let lastReason: EarningsUnavailableReason | null = null;
  let lastProvider: EarningsProviderId | null = null;
  let configured = false;

  for (const provider of chain) {
    if (!provider.apiKey) continue;
    configured = true;
    try {
      const resolution = await cache.resolve(
        `earnings:${provider.id}:${symbol}`,
        provider.load,
        CACHE_POLICY,
      );
      const upcoming = nextEarnings(resolution.value.candidates, today);
      if (!upcoming) {
        lastReason = 'no-scheduled-report';
        lastProvider = provider.id;
        continue;
      }
      const schedule: EarningsSchedule = {
        status: 'available',
        symbol,
        reportDate: upcoming.reportDate,
        timeOfDay: upcoming.timeOfDay,
        epsEstimate: upcoming.epsEstimate,
        daysToEarnings: upcoming.daysToEarnings,
        provider: provider.id,
        asOf: new Date(resolution.storedAt).toISOString(),
        stale: resolution.state === 'stale',
      };
      /*
       * Remembered with the timestamp of the answer that produced it, not with
       * "now": a value the in-process cache served from a week-old fetch must
       * not reset the 24-hour TTL, or a single successful fetch could keep
       * refreshing itself forever without a provider ever being asked again.
       */
      const entry = entryFromSchedule(schedule, schedule.asOf);
      if (entry) await store.write(entry).catch(() => false);
      return schedule;
    } catch (cause) {
      lastReason = reasonFor(cause);
      lastProvider = provider.id;
    }
  }

  if (!configured) return unavailable('not-configured', null);
  return unavailable(lastReason ?? 'provider-unavailable', lastProvider);
}
