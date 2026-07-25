import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError } from './errors';
import type { MarketDataProvider } from './types';
import { AlphaVantageProvider } from './providers/alpha-vantage/provider';
import { StooqHistoricalProvider } from './providers/stooq/provider';
import { NasdaqHistoricalProvider } from './providers/nasdaq/provider';
import { YahooHistoricalProvider } from './providers/yahoo/historical';
import { HistoricalMarketDataService, type HistoricalProvider } from './historical-service';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import type { CompanyProfile, HistoricalPrices, HistoricalRange, MarketOverview, ProviderResult, Quote, SymbolSearchResult } from './types';
import {
  CompanyProfileService,
  type CompanyProfileProvider,
} from './profile-service';
import { FinancialModelingPrepProfileProvider } from './providers/financial-modeling-prep/provider';

export const MARKET_DATA_PROVIDER_ID = 'alpha-vantage';
const cache = new SharedRequestCache();
let providerKey: string | undefined;
let providerInstance: MarketDataProvider | undefined;
let historicalProviderKey: string | undefined;
let historicalService: HistoricalMarketDataService | undefined;
let profileProviderKey: string | undefined;
let profileService: CompanyProfileService | undefined;

function cachedResult<T>(
  result: ProviderResult<T>,
  state: 'fresh' | 'cache' | 'stale',
  storedAt: number,
): ProviderResult<T> {
  return {
    ...result,
    freshness: {
      ...result.freshness,
      status: state === 'fresh'
        ? result.freshness.status
        : state === 'stale' ? 'stale' : 'cached',
      cachedAt: new Date(storedAt).toISOString(),
    },
  };
}

class CachedMarketDataProvider implements MarketDataProvider {
  readonly id: string;
  constructor(
    private readonly source: MarketDataProvider,
    private readonly profiles: CompanyProfileService,
  ) {
    this.id = source.id;
  }
  private async get<T>(key: string, operation: () => Promise<ProviderResult<T>>, freshMs: number, staleMs: number) {
    const result = await cache.resolve(key, operation, { freshMs, staleMs, errorMs: 30_000 });
    return cachedResult(result.value, result.state, result.storedAt);
  }
  search(query: string): Promise<ProviderResult<SymbolSearchResult[]>> { return this.get(`search:${query}`, () => this.source.search(query), 3_600_000, 3_600_000); }
  getQuote(symbol: string): Promise<ProviderResult<Quote>> { return this.get(`quote:${symbol}`, () => this.source.getQuote(symbol), 60_000, 15 * 60_000); }
  getHistoricalPrices(symbol: string, range: HistoricalRange): Promise<ProviderResult<HistoricalPrices>> { return this.get(`history:${symbol}:${range}`, () => this.source.getHistoricalPrices(symbol, range), 15 * 60_000, 24 * 60 * 60_000); }
  getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>> {
    return this.profiles.getCompanyProfile(symbol);
  }
  getMarketOverview(): Promise<ProviderResult<MarketOverview>> { return this.get('overview', () => this.source.getMarketOverview(), 5 * 60_000, 30 * 60_000); }
}

export function getMarketDataProvider(): MarketDataProvider {
  if (!serverEnv.ALPHA_VANTAGE_API_KEY) {
    throw new MarketDataError(
      'provider-not-configured',
      'Market data provider is not configured',
    );
  }
  if (!providerInstance || providerKey !== serverEnv.ALPHA_VANTAGE_API_KEY) {
    providerKey = serverEnv.ALPHA_VANTAGE_API_KEY;
    providerInstance = new CachedMarketDataProvider(
      new AlphaVantageProvider(providerKey),
      getCompanyProfileService(),
    );
  }
  return providerInstance;
}

class UnconfiguredCompanyProfileProvider implements CompanyProfileProvider {
  readonly id = MARKET_DATA_PROVIDER_ID;

  async getCompanyProfile(): Promise<never> {
    throw new MarketDataError(
      'provider-not-configured',
      'Primary company profile provider is not configured',
    );
  }
}

export function getCompanyProfileService(): CompanyProfileService {
  const alphaKey = serverEnv.ALPHA_VANTAGE_API_KEY;
  const secondaryKey = serverEnv.FMP_API_KEY;
  const configurationKey = `${alphaKey ?? ''}\u0000${secondaryKey ?? ''}`;
  if (!profileService || profileProviderKey !== configurationKey) {
    profileProviderKey = configurationKey;
    profileService = new CompanyProfileService(
      alphaKey
        ? new AlphaVantageProvider(alphaKey)
        : new UnconfiguredCompanyProfileProvider(),
      secondaryKey
        ? new FinancialModelingPrepProfileProvider(secondaryKey)
        : null,
    );
  }
  return profileService;
}

class UnconfiguredHistoricalProvider implements HistoricalProvider {
  readonly id = MARKET_DATA_PROVIDER_ID;
  async getHistoricalPrices(): Promise<never> {
    throw new MarketDataError('provider-not-configured', 'Primary market data provider is not configured');
  }
}

class CascadingHistoricalProvider implements HistoricalProvider {
  readonly id: string;

  constructor(
    private readonly primary: HistoricalProvider,
    private readonly fallback: HistoricalProvider,
  ) {
    this.id = `${primary.id}+${fallback.id}`;
  }

  async getHistoricalPrices(symbol: string, range: HistoricalRange) {
    try {
      return await this.primary.getHistoricalPrices(symbol, range);
    } catch {
      return this.fallback.getHistoricalPrices(symbol, range);
    }
  }
}

export function getHistoricalMarketDataService(): HistoricalMarketDataService {
  const key = serverEnv.ALPHA_VANTAGE_API_KEY;
  if (!historicalService || historicalProviderKey !== key) {
    historicalProviderKey = key;
    const primary = key ? new AlphaVantageProvider(key) : new UnconfiguredHistoricalProvider();
    historicalService = new HistoricalMarketDataService(
      primary,
      new StooqHistoricalProvider(),
      Date.now,
      new CascadingHistoricalProvider(
        new NasdaqHistoricalProvider(),
        new YahooHistoricalProvider(),
      ),
    );
  }
  return historicalService;
}

export type {
  CompanyProfile,
  DataFreshness,
  HistoricalPrice,
  HistoricalPrices,
  HistoricalRange,
  MarketDataEnvelope,
  MarketDataProvider,
  MarketOverview,
  Quote,
  SymbolSearchResult,
} from './types';
