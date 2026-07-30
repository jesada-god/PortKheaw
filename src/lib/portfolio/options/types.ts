import type { OptionKind, OptionSide, PortfolioTransaction } from '../types';

export type { OptionKind, OptionSide };

export type OptionQuoteFreshness = 'live' | 'delayed' | 'cached' | 'stale' | 'missing';

export interface OptionQuoteInput {
  bid: number | null;
  ask: number | null;
  mark: number | null;
  previousClose?: number | null;
  underlyingPrice: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  theta: number | null;
  source: string | null;
  asOf: string | null;
  freshness: OptionQuoteFreshness;
}

export interface OptionPositionSummary {
  key: string;
  underlyingSymbol: string;
  contractSymbol: string;
  optionKind: OptionKind;
  side: OptionSide;
  strikePrice: number;
  expirationDate: string;
  contracts: number;
  multiplier: number;
  averagePremium: number;
  remainingCost: number;
  realizedGain: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  estimatedClosePrice: number | null;
  marketValue: number | null;
  estimatedCloseValue: number | null;
  todayChange: number | null;
  unrealizedGain: number | null;
  unrealizedGainPercent: number | null;
  underlyingPrice: number | null;
  breakeven: number;
  dte: number;
  impliedVolatility: number | null;
  delta: number | null;
  theta: number | null;
  status: 'open' | 'closed' | 'expired';
  quoteSource: string | null;
  quoteAsOf: string | null;
  quoteFreshness: OptionQuoteFreshness;
  transactions: PortfolioTransaction[];
}

export interface OptionLedgerSummary {
  positions: OptionPositionSummary[];
  cashFlow: number;
  realizedGain: number;
  unrealizedGain: number | null;
  marketValue: number | null;
  remainingCost: number;
  todayChange: number | null;
  hasMissingPrices: boolean;
}

export type OptionTargetMode = 'premium' | 'profit_percent';

export interface OptionTarget {
  id: string;
  portfolioId: string;
  contractSymbol: string;
  side: OptionSide;
  mode: OptionTargetMode;
  targetValue: number;
  targetPremium: number;
  estimatedFee: number;
  enabled: boolean;
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OptionTargetCalculation {
  targetPremium: number;
  estimatedProceeds: number;
  estimatedProfit: number;
  estimatedProfitPercent: number;
  distanceFromCurrent: number | null;
  distancePercent: number | null;
}
