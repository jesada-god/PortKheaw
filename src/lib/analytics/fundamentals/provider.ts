import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import type { FinancialPeriod } from './types';
import { AlphaVantageFundamentalsProvider } from './providers/alpha-vantage';
import { FinancialModelingPrepFundamentalsProvider } from './providers/financial-modeling-prep';
import { SecCompanyFactsFundamentalsProvider } from './providers/sec-companyfacts';
import { createFundamentalsLkgRepository } from './repository';
import { FundamentalsService } from './service';
import type { NormalizedFinancialRecord } from './normalize';

export interface FundamentalsDiagnostics {
  provider: string;
  capabilities: string[];
  datasets: Record<string, 'available' | 'unavailable'>;
  cache: Record<string, 'hit' | 'miss' | 'stale'>;
  datasetFetchedAt: Record<string, string | null>;
  latencyMs: number;
  normalizedPeriodCount: { annual: number; quarterly: number };
}

export interface FundamentalsSnapshot {
  symbol: string;
  periods: FinancialPeriod[];
  quarterlyPeriods: FinancialPeriod[];
  annualRecords: NormalizedFinancialRecord[];
  quarterlyRecords: NormalizedFinancialRecord[];
  asOf: string;
  fetchedAt: string;
  currency: string;
  dilutedEpsTtm: number | null;
  dilutedEpsAsOf: string | null;
  missingInputs: string[];
  /**
   * Provider error code per dataset that failed to load (e.g. `rate-limited`,
   * `provider-unauthorized`). Lets downstream analytics report a truthful typed
   * reason instead of mislabelling a throttled provider as "insufficient data".
   */
  datasetErrors: Record<string, string>;
  diagnostics: FundamentalsDiagnostics;
  /**
   * Truthful provider provenance. `providerUsed` is the provider whose real
   * dataset produced `periods`; when it differs from `primaryProvider` a secondary
   * provider satisfied the request after an eligible temporary primary failure.
   * These are optional so single-provider snapshots stay backward compatible.
   */
  primaryProvider?: string;
  providerUsed?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  /** Canonical availability provenance used by acceptance diagnostics. */
  dataState?:
    | 'provider-live'
    | 'provider-cached'
    | 'provider-stale'
    | 'authoritative-filing';
}

/** Vendor-neutral server-only capability boundary. */
export interface FundamentalsProvider {
  readonly id: string;
  getFinancialPeriods(symbol: string, signal?: AbortSignal): Promise<FundamentalsSnapshot>;
  getConsensusForwardEps?(symbol: string): Promise<{ value: number; period: string; asOf: string; analystCount: number }>;
}

let instance: FundamentalsProvider | null = null;
let instanceKey: string | undefined;

export function getFundamentalsProvider(): FundamentalsProvider | null {
  const primaryKey = serverEnv.ALPHA_VANTAGE_API_KEY;
  const secondaryKey = serverEnv.FMP_API_KEY;
  const secUserAgent = serverEnv.SEC_USER_AGENT;
  if (!primaryKey && !secondaryKey && !secUserAgent) return null;
  // Rebuild only when a relevant credential changes; the composite keeps the
  // primary provider id so existing provenance and cache keys stay stable.
  const configurationKey = `${primaryKey ?? ''}\u0000${secondaryKey ?? ''}\u0000${secUserAgent ?? ''}`;
  if (!instance || instanceKey !== configurationKey) {
    instanceKey = configurationKey;
    const filingProvider = secUserAgent
      ? new SecCompanyFactsFundamentalsProvider(secUserAgent)
      : null;
    const primary = primaryKey
      ? new AlphaVantageFundamentalsProvider(primaryKey)
      : secondaryKey
        ? new FinancialModelingPrepFundamentalsProvider(secondaryKey)
        : filingProvider!;
    const secondary = primaryKey && secondaryKey
      ? new FinancialModelingPrepFundamentalsProvider(secondaryKey)
      : null;
    const authoritativeFallback = primary.id === 'sec-companyfacts'
      ? null : filingProvider;
    instance = new FundamentalsService(primary, secondary, Date.now, undefined, {
      repository: createFundamentalsLkgRepository(),
      authoritativeFallback,
    });
  }
  return instance;
}
