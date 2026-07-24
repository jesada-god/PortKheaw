import { z } from 'zod';

const finiteNumber = z.number().finite();
const nullableNumber = finiteNumber.nullable();

export const freshnessSchema = z.object({
  status: z.enum(['realtime', 'delayed', 'end-of-day', 'cached', 'stale', 'unknown', 'unavailable']),
  asOf: z.iso.datetime().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().nullable(),
  cachedAt: z.iso.datetime().optional(),
  staleWhileRevalidateSeconds: z.number().int().nonnegative().optional(),
});

export type DataFreshness = z.infer<typeof freshnessSchema>;

export const symbolSearchResultSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  assetType: z.string(),
  exchange: z.string().nullable(),
  status: z.enum(['active', 'delisted']),
  region: z.string().optional(),
  currency: z.string().nullable(),
  marketOpen: z.string().nullable(),
  marketClose: z.string().nullable(),
  timezone: z.string().nullable(),
  matchScore: z.number().min(0).max(1).nullable(),
});

export const quoteSchema = z.object({
  symbol: z.string(),
  currency: z.string().nullable().optional(),
  price: finiteNumber,
  open: nullableNumber,
  high: nullableNumber,
  low: nullableNumber,
  previousClose: nullableNumber,
  change: nullableNumber,
  changePercent: nullableNumber,
  volume: z.number().int().nonnegative().nullable(),
  latestTradingDay: z.iso.date().nullable(),
  /** Explicit regular-session comparison base retained across normalization. */
  previousRegularClose: nullableNumber.optional(),
  /** Exchange/provider timestamp for the displayed price. */
  quoteTimestamp: z.iso.datetime().nullable().optional(),
  /** Session represented by the displayed price, never inferred by the browser. */
  session: z.enum(['pre-market', 'regular', 'after-hours', 'closed', 'unknown']).optional(),
  /** Safe, non-secret provenance labels for the price and comparison base. */
  priceSource: z.string().nullable().optional(),
  previousCloseSource: z.string().nullable().optional(),
});

export const historicalPriceSchema = z.object({
  date: z.iso.date(),
  open: finiteNumber,
  high: finiteNumber,
  low: finiteNumber,
  close: finiteNumber,
  volume: z.number().int().nonnegative().nullable(),
});

export const historicalPricesSchema = z.object({
  symbol: z.string(),
  range: z.enum(['1m', '3m', '6m', '1y', '5y', 'max']),
  interval: z.literal('1d'),
  prices: z.array(historicalPriceSchema),
  providerUsed: z.string().optional(),
  fallbackReason: z.string().nullable().optional(),
  cachedAt: z.iso.datetime().optional(),
  asOf: z.iso.datetime().nullable().optional(),
  freshness: z.enum(['fresh', 'cached', 'stale']).optional(),
  methodology: z.string().optional(),
  limitations: z.array(z.string()).optional(),
});

export const companyProfileSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  exchange: z.string().nullable(),
  currency: z.string().nullable(),
  country: z.string().nullable(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  website: z.url().nullable(),
  marketCapitalization: nullableNumber,
  employees: z.number().int().nonnegative().nullable(),
  fiscalYearEnd: z.string().nullable(),
  latestQuarter: z.iso.date().nullable(),
});

export const marketStatusSchema = z.object({
  marketType: z.string(),
  region: z.string(),
  primaryExchanges: z.array(z.string()),
  localOpen: z.string().nullable(),
  localClose: z.string().nullable(),
  currentStatus: z.enum(['pre-market', 'open', 'after-hours', 'closed', 'holiday', 'early-close', 'unknown']),
  notes: z.string().nullable(),
});

export const marketOverviewSchema = z.object({
  markets: z.array(marketStatusSchema),
});

export type SymbolSearchResult = z.infer<typeof symbolSearchResultSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type HistoricalPrice = z.infer<typeof historicalPriceSchema>;
export type HistoricalPrices = z.infer<typeof historicalPricesSchema>;
export type HistoricalRange = HistoricalPrices['range'];
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export type MarketOverview = z.infer<typeof marketOverviewSchema>;
export type MarketStatusState = z.infer<typeof marketStatusSchema>['currentStatus'];

export type {
  MarketDataStatus,
  OptionContract,
  OptionsChain,
  OptionsExpirations,
} from './options/contracts';
export type {
  CanonicalIntradayBar,
  CanonicalIntradaySeries,
  IntradayInterval,
  IntradayRange,
  IntradaySessionMode,
  IntradaySessionType,
} from './intraday/contracts';

export interface ProviderResult<T> {
  data: T;
  freshness: DataFreshness;
  provider?: string;
}

export interface MarketDataProvider {
  readonly id: string;
  search(query: string): Promise<ProviderResult<SymbolSearchResult[]>>;
  getQuote(symbol: string): Promise<ProviderResult<Quote>>;
  getHistoricalPrices(symbol: string, range: HistoricalRange): Promise<ProviderResult<HistoricalPrices>>;
  getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>>;
  getMarketOverview(): Promise<ProviderResult<MarketOverview>>;
}

export const marketDataErrorCodeSchema = z.enum([
  'provider-not-configured',
  'invalid-request',
  'invalid-symbol',
  'not-found',
  'rate-limited',
  'timeout',
  'provider-unauthorized',
  'forbidden',
  'provider-unavailable',
  'unsupported',
  'stale-data',
  'upstream-unavailable',
  'invalid-provider-response',
  'insufficient-data',
  'internal-error',
]);

export type MarketDataErrorCode = z.infer<typeof marketDataErrorCodeSchema>;

export const responseMetaSchema = z.object({
  provider: z.string().nullable(),
  timestamp: z.iso.datetime(),
  freshness: freshnessSchema,
});

export const apiErrorSchema = z.object({
  code: marketDataErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().positive().optional(),
  retryAfter: z.number().int().positive().optional(),
  reason: z.string().optional(),
  lastAvailableAt: z.iso.datetime().nullable().optional(),
  primaryReason: z.string().optional(),
  fallbackReason: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type MarketDataApiError = z.infer<typeof apiErrorSchema>;

export interface HistoricalUnavailableData {
  status: 'unavailable';
  reason: string;
  primaryReason: string;
  fallbackReason: string;
  retryable: boolean;
  retryAfter: string | null;
  retryAfterSeconds: number;
  lastAvailableAt: string | null;
}

export interface MarketDataEnvelope<T> {
  data: T | null;
  error?: MarketDataApiError;
  meta: z.infer<typeof responseMetaSchema>;
}
