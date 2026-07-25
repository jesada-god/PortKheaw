import type { DataFreshness, HistoricalPrice } from '@/src/lib/market-data/types';

export type AnalyticsSourceType = 'provider-supplied' | 'calculated' | 'estimated' | 'user-provided';
export type MetricStatus = 'available' | 'unavailable' | 'not-meaningful' | 'delayed' | 'stale';

export interface FinancialPeriod {
  periodEnd: string;
  currency: string;
  revenue: number;
  operatingIncome: number;
  netIncome: number;
  depreciationAmortization: number;
  capitalExpenditure: number;
  changeInWorkingCapital: number | null;
  operatingCashFlow: number;
  freeCashFlow: number;
  dividendsPaid: number | null;
  interestExpense: number;
  totalDebt: number;
  cash: number;
  totalAssets: number;
  totalLiabilities: number;
  dilutedShares: number;
  incomeBeforeTax?: number | null;
  incomeTaxExpense?: number | null;
  grossProfit?: number | null;
  ebitda?: number | null;
  dilutedEps?: number | null;
  totalEquity?: number | null;
  restated?: boolean;
}

export interface MetricMetadata {
  symbol: string;
  currency: string | null;
  source: string;
  sourceType: AnalyticsSourceType;
  period: string;
  asOf: string | null;
  latestDataAt: string | null;
  calculatedAt: string;
  freshness: DataFreshness;
  methodology: string;
  inputs: Record<string, number | string | null>;
  assumptions: string[];
  limitations: string[];
}

export type MetricResult =
  | (MetricMetadata & { status: 'available' | 'delayed' | 'stale'; value: number; unit: string })
  | (MetricMetadata & { status: 'unavailable' | 'not-meaningful'; reason: string; missingInputs: string[] });

export interface KeyStatisticsResult {
  status: 'available';
  symbol: string;
  currency: string | null;
  source: string;
  sourceType: AnalyticsSourceType;
  period: string;
  asOf: string | null;
  latestDataAt: string | null;
  calculatedAt: string;
  freshness: DataFreshness;
  methodology: string;
  inputs: Record<string, number | string | null>;
  assumptions: string[];
  limitations: string[];
  metrics: Record<string, MetricResult>;
}

export interface KeyStatisticsInput {
  symbol: string;
  currency: string | null;
  provider: string;
  price: number | null;
  priceAsOf: string | null;
  freshness: DataFreshness;
  currentVolume: number | null;
  marketCap: number | null;
  dilutedEpsTtm?: number | null;
  dilutedEpsCurrency?: string | null;
  fundamentalsProvider?: string | null;
  fundamentalsAsOf?: string | null;
  fundamentalsMissingInputs?: string[];
  forwardConsensusEps?: number | null;
  sharesOutstanding?: number | null;
  dilutedShares?: number | null;
  history: readonly HistoricalPrice[];
  calculatedAt?: string;
}
