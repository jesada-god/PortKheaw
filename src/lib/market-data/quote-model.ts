import type { OptionContract } from './options/contracts';

export type CanonicalQuoteFreshness = 'LIVE' | 'DELAYED' | 'STALE' | 'CACHED' | 'UNAVAILABLE';

export interface CanonicalQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  midpoint: number | null;
  timestamp: string | null;
  source: string | null;
  freshness: CanonicalQuoteFreshness;
}

export interface OptionMarketQuote {
  contract: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  midpoint: number | null;
  bidSize: number | null;
  askSize: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  timestamp: string;
  source: string;
  freshness: CanonicalQuoteFreshness;
}

function usable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

export function quoteFreshness(value: string | null | undefined): CanonicalQuoteFreshness {
  switch (value?.toLowerCase()) {
    case 'live':
    case 'real-time':
    case 'realtime':
      return 'LIVE';
    case 'delayed':
    case 'end-of-day':
      return 'DELAYED';
    case 'cached':
      return 'CACHED';
    case 'stale':
      return 'STALE';
    default:
      return 'UNAVAILABLE';
  }
}

/** Midpoint exists only for a valid, non-crossed two-sided market. */
export function validMidpoint(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (!usable(bid) || !usable(ask) || bid > ask) return null;
  return (bid + ask) / 2;
}

export function canonicalQuote(input: Omit<CanonicalQuote, 'midpoint'>): CanonicalQuote {
  const midpoint = validMidpoint(input.bid, input.ask);
  const twoSided = midpoint !== null;
  return {
    ...input,
    bid: twoSided ? input.bid : null,
    ask: twoSided ? input.ask : null,
    bidSize: twoSided && usable(input.bidSize) ? input.bidSize : null,
    askSize: twoSided && usable(input.askSize) ? input.askSize : null,
    midpoint,
  };
}

export function optionMarketQuote(contract: OptionContract): OptionMarketQuote {
  const midpoint = validMidpoint(contract.bid, contract.ask);
  const twoSided = midpoint !== null;
  return {
    contract: contract.contractSymbol,
    bid: twoSided ? contract.bid : null,
    ask: twoSided ? contract.ask : null,
    last: usable(contract.last) ? contract.last : null,
    midpoint,
    bidSize: null,
    askSize: null,
    volume: contract.volume,
    openInterest: contract.openInterest,
    impliedVolatility: contract.impliedVolatility,
    timestamp: contract.asOf,
    source: contract.provider,
    freshness: quoteFreshness(contract.status),
  };
}

export function optionIntrinsicValue(contract: Pick<OptionContract, 'type' | 'strike'>, spot: number): number {
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  return contract.type === 'call'
    ? Math.max(0, spot - contract.strike)
    : Math.max(0, contract.strike - spot);
}
