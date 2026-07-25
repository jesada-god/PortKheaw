export type AnalystTargetProvider = 'finnhub' | 'alpha-vantage';

export type AnalystConsensusStatus =
  | 'available'
  | 'fallback'
  | 'stale'
  | 'not-entitled'
  | 'rate-limited'
  | 'unavailable'
  | 'provider-error';

export type ProviderAvailabilityStatus =
  | 'available'
  | 'unconfigured'
  | 'not-entitled'
  | 'rate-limited'
  | 'invalid-key'
  | 'unavailable'
  | 'provider-error';

export interface ProviderAvailability {
  provider: AnalystTargetProvider;
  providerLabel: string;
  endpoint: 'stock/price-target' | 'OVERVIEW';
  status: ProviderAvailabilityStatus;
  message: string;
  checkedAt: string;
}

export interface AnalystTargetSnapshot {
  symbol: string;
  targetPrice: number;
  medianTarget: number | null;
  highTarget: number | null;
  lowTarget: number | null;
  analystCount: number | null;
  provider: AnalystTargetProvider;
  providerLabel: 'Finnhub' | 'Alpha Vantage';
  currency: string | null;
  lastUpdated: string | null;
}

export interface AnalystConsensusResult {
  symbol: string;
  targetPrice: number | null;
  medianTarget: number | null;
  highTarget: number | null;
  lowTarget: number | null;
  analystCount: number | null;
  currentPrice: number | null;
  currentPriceAsOf: string | null;
  upsideDownsidePct: number | null;
  provider: AnalystTargetProvider | null;
  providerLabel: string | null;
  currency: string | null;
  lastUpdated: string | null;
  cachedAt: string | null;
  stale: boolean;
  status: AnalystConsensusStatus;
  coverage: ProviderAvailability[];
}
