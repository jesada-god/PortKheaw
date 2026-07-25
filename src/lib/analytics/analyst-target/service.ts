import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { SharedRequestCache, type CacheResolution } from '@/src/lib/shared-request-cache';
import { calculateUpsideDownsidePct, positiveFinite } from './calculations';
import {
  availabilityStatus,
  loadAlphaVantagePriceTarget,
  loadFinnhubPriceTarget,
  type ProviderRequestOptions,
} from './providers';
import type {
  AnalystConsensusResult,
  AnalystConsensusStatus,
  AnalystTargetProvider,
  AnalystTargetSnapshot,
  ProviderAvailability,
  ProviderAvailabilityStatus,
} from './types';

export type { AnalystConsensusResult, ProviderAvailability } from './types';

const CACHE_POLICY = {
  freshMs: 24 * 60 * 60_000,
  staleMs: 24 * 60 * 60_000,
  errorMs: 5 * 60_000,
} as const;

const sharedCache = new SharedRequestCache();

export interface LoadAnalystConsensusOptions extends ProviderRequestOptions {
  finnhubApiKey?: string | null;
  alphaVantageApiKey?: string | null;
  listingCurrency?: string | null;
  currentPrice?: number | null;
  currentPriceAsOf?: string | null;
  now?: () => number;
  cache?: SharedRequestCache;
}

interface ProviderSelection {
  target: AnalystTargetSnapshot;
  coverage: ProviderAvailability[];
  fallback: boolean;
}

class ProviderChainError extends Error {
  constructor(public readonly coverage: ProviderAvailability[]) {
    super('No analyst target provider returned a valid result');
    this.name = 'ProviderChainError';
  }
}

function providerLabel(provider: AnalystTargetProvider): 'Finnhub' | 'Alpha Vantage' {
  return provider === 'finnhub' ? 'Finnhub' : 'Alpha Vantage';
}

function providerMessage(
  provider: AnalystTargetProvider,
  status: ProviderAvailabilityStatus,
): string {
  const name = providerLabel(provider);
  const messages: Record<ProviderAvailabilityStatus, string> = {
    available: `${name}: ใช้งานได้`,
    unconfigured: `${name}: ยังไม่ได้ตั้งค่า API key บนเซิร์ฟเวอร์`,
    'not-entitled': `${name}: API plan ปัจจุบันไม่รองรับ Price Target`,
    'rate-limited': `${name}: ถูกจำกัดการเรียกชั่วคราว`,
    'invalid-key': `${name}: การตั้งค่าผู้ให้บริการไม่พร้อมใช้งาน`,
    unavailable: provider === 'alpha-vantage'
      ? `${name}: ไม่พบ Analyst Target`
      : `${name}: ไม่พบ Price Target`,
    'provider-error': `${name}: ดึงข้อมูลไม่สำเร็จชั่วคราว`,
  };
  return messages[status];
}

function coverage(
  provider: AnalystTargetProvider,
  endpoint: ProviderAvailability['endpoint'],
  status: ProviderAvailabilityStatus,
  now: number,
): ProviderAvailability {
  return {
    provider,
    providerLabel: providerLabel(provider),
    endpoint,
    status,
    message: providerMessage(provider, status),
    checkedAt: new Date(now).toISOString(),
  };
}

async function selectProvider(
  symbol: string,
  finnhubApiKey: string | null,
  alphaVantageApiKey: string | null,
  requestOptions: ProviderRequestOptions,
  now: number,
): Promise<ProviderSelection> {
  const providerCoverage: ProviderAvailability[] = [];

  if (finnhubApiKey) {
    try {
      const target = await loadFinnhubPriceTarget(symbol, finnhubApiKey, requestOptions);
      providerCoverage.push(coverage('finnhub', 'stock/price-target', 'available', now));
      return { target, coverage: providerCoverage, fallback: false };
    } catch (error) {
      providerCoverage.push(coverage(
        'finnhub',
        'stock/price-target',
        availabilityStatus(error),
        now,
      ));
    }
  } else {
    providerCoverage.push(coverage(
      'finnhub',
      'stock/price-target',
      'unconfigured',
      now,
    ));
  }

  if (alphaVantageApiKey) {
    try {
      const target = await loadAlphaVantagePriceTarget(
        symbol,
        alphaVantageApiKey,
        requestOptions,
      );
      providerCoverage.push(coverage('alpha-vantage', 'OVERVIEW', 'available', now));
      return { target, coverage: providerCoverage, fallback: true };
    } catch (error) {
      providerCoverage.push(coverage(
        'alpha-vantage',
        'OVERVIEW',
        availabilityStatus(error),
        now,
      ));
    }
  } else {
    providerCoverage.push(coverage(
      'alpha-vantage',
      'OVERVIEW',
      'unconfigured',
      now,
    ));
  }

  throw new ProviderChainError(providerCoverage);
}

function unavailableStatus(coverageItems: ProviderAvailability[]): AnalystConsensusStatus {
  const statuses = new Set(coverageItems.map((item) => item.status));
  if (statuses.has('rate-limited')) return 'rate-limited';
  if (statuses.has('invalid-key') || statuses.has('provider-error')) return 'provider-error';
  if (statuses.has('not-entitled')) return 'not-entitled';
  return 'unavailable';
}

function unavailableResult(
  symbol: string,
  listingCurrency: string | null,
  currentPrice: number | null,
  currentPriceAsOf: string | null,
  coverageItems: ProviderAvailability[],
): AnalystConsensusResult {
  return {
    symbol,
    targetPrice: null,
    medianTarget: null,
    highTarget: null,
    lowTarget: null,
    analystCount: null,
    currentPrice,
    currentPriceAsOf: currentPrice === null ? null : currentPriceAsOf,
    upsideDownsidePct: null,
    provider: null,
    providerLabel: null,
    currency: listingCurrency,
    lastUpdated: null,
    cachedAt: null,
    stale: false,
    status: unavailableStatus(coverageItems),
    coverage: coverageItems,
  };
}

function successfulResult(
  selection: ProviderSelection,
  resolution: CacheResolution<ProviderSelection>,
  listingCurrency: string | null,
  rawCurrentPrice: number | null,
  currentPriceAsOf: string | null,
): AnalystConsensusResult {
  const currentPrice = positiveFinite(rawCurrentPrice);
  const stale = resolution.state === 'stale';
  const failedCoverage = stale && resolution.error instanceof ProviderChainError
    ? resolution.error.coverage
    : selection.coverage;
  return {
    symbol: selection.target.symbol,
    targetPrice: selection.target.targetPrice,
    medianTarget: selection.target.medianTarget,
    highTarget: selection.target.highTarget,
    lowTarget: selection.target.lowTarget,
    analystCount: selection.target.analystCount,
    currentPrice,
    currentPriceAsOf: currentPrice === null ? null : currentPriceAsOf,
    upsideDownsidePct: calculateUpsideDownsidePct(
      selection.target.targetPrice,
      currentPrice,
    ),
    provider: selection.target.provider,
    providerLabel: selection.target.providerLabel,
    currency: selection.target.currency ?? listingCurrency,
    lastUpdated: selection.target.lastUpdated,
    cachedAt: new Date(resolution.storedAt).toISOString(),
    stale,
    status: stale ? 'stale' : selection.fallback ? 'fallback' : 'available',
    coverage: failedCoverage,
  };
}

export async function loadAnalystConsensus(
  rawSymbol: string,
  options: LoadAnalystConsensusOptions = {},
): Promise<AnalystConsensusResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const now = (options.now ?? Date.now)();
  const cache = options.cache ?? sharedCache;
  const finnhubApiKey = options.finnhubApiKey ?? serverEnv.FINNHUB_API_KEY ?? null;
  const alphaVantageApiKey = options.alphaVantageApiKey
    ?? serverEnv.ALPHA_VANTAGE_API_KEY
    ?? null;
  const listingCurrency = options.listingCurrency?.trim().toUpperCase() ?? null;
  const currentPrice = positiveFinite(options.currentPrice);
  const requestOptions: ProviderRequestOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    sleep: options.sleep,
  };

  try {
    const resolution = await cache.resolve(
      `analyst-target:v2:${symbol}`,
      () => selectProvider(
        symbol,
        finnhubApiKey,
        alphaVantageApiKey,
        requestOptions,
        now,
      ),
      CACHE_POLICY,
    );
    return successfulResult(
      resolution.value,
      resolution,
      listingCurrency,
      currentPrice,
      options.currentPriceAsOf ?? null,
    );
  } catch (error) {
    const providerCoverage = error instanceof ProviderChainError
      ? error.coverage
      : [
        coverage('finnhub', 'stock/price-target', 'provider-error', now),
        coverage('alpha-vantage', 'OVERVIEW', 'provider-error', now),
      ];
    return unavailableResult(
      symbol,
      listingCurrency,
      currentPrice,
      options.currentPriceAsOf ?? null,
      providerCoverage,
    );
  }
}

export function clearAnalystConsensusCacheForTests(): void {
  sharedCache.clear();
}
