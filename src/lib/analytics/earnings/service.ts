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
}

function reasonFor(error: unknown): EarningsUnavailableReason {
  if (error instanceof MarketDataError) {
    if (error.code === 'forbidden' || error.code === 'provider-unauthorized') return 'entitlement-unavailable';
    if (error.code === 'rate-limited') return 'rate-limited';
  }
  return 'provider-unavailable';
}

const MESSAGES: Record<EarningsUnavailableReason, string> = {
  'not-configured': 'ยังไม่ได้ตั้งค่าผู้ให้บริการปฏิทินงบการเงินบนเซิร์ฟเวอร์',
  'no-scheduled-report': 'ผู้ให้บริการยังไม่ประกาศวันประกาศงบครั้งถัดไป',
  'entitlement-unavailable': 'แพ็กเกจของผู้ให้บริการไม่รองรับปฏิทินงบการเงิน',
  'rate-limited': 'ผู้ให้บริการจำกัดจำนวนคำขอชั่วคราว',
  'provider-unavailable': 'ดึงวันประกาศงบจากผู้ให้บริการไม่สำเร็จ',
};

/**
 * Next scheduled earnings report for `symbol`.
 *
 * Alpha Vantage's symbol-filtered calendar is primary because it also dates the
 * session (pre/post market); Financial Modeling Prep is the deterministic
 * secondary. Both are real, entitled endpoints — when neither answers, the
 * result is a typed unavailable state and the Options Signal engine drops the
 * event-risk factor rather than assuming "no earnings soon".
 */
export async function loadEarningsSchedule(
  rawSymbol: string,
  options: LoadEarningsScheduleOptions = {},
): Promise<EarningsSchedule> {
  const symbol = rawSymbol.trim().toUpperCase();
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedCache;
  const alphaVantageApiKey = options.alphaVantageApiKey ?? serverEnv.ALPHA_VANTAGE_API_KEY ?? null;
  const fmpApiKey = options.fmpApiKey ?? serverEnv.FMP_API_KEY ?? null;
  const nowIso = new Date(now()).toISOString();
  // Earnings dates are published as US exchange-local dates, so "today" must be
  // resolved in America/New_York; a Bangkok-local date is up to a day ahead.
  const today = exchangeSessionDate(nowIso, US_EQUITY_TIMEZONE) ?? nowIso.slice(0, 10);

  const unavailable = (reason: EarningsUnavailableReason, provider: EarningsProviderId | null): EarningsSchedule => ({
    status: 'unavailable',
    symbol,
    reason,
    message: MESSAGES[reason],
    provider,
    asOf: nowIso,
  });

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
      return {
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
    } catch (cause) {
      lastReason = reasonFor(cause);
      lastProvider = provider.id;
    }
  }

  if (!configured) return unavailable('not-configured', null);
  return unavailable(lastReason ?? 'provider-unavailable', lastProvider);
}
