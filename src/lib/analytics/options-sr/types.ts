import type { MarketDataStatus, OptionContract } from '@/src/lib/market-data/options/contracts';

/**
 * Options-Driven Support/Resistance (Phase C.2).
 *
 * These are truthful *reference levels* derived from real, provider-supplied
 * open interest — never a claim that market makers will pin, support, or resist
 * price. Every field is computed deterministically from data the entitled
 * provider actually returned; a genuinely-absent input (OI, Greeks) is surfaced
 * as a typed unavailable state, never inferred or fabricated.
 */

/** How a level was derived. Greeks-weighted variants exist only when real Greeks are present. */
export type OptionsLevelMethod = 'call-oi-concentration' | 'put-oi-concentration' | 'min-total-payout';

export type OptionsLevelSource = 'call-oi' | 'put-oi' | 'max-pain';

/** Deterministic, non-predictive quality tier. Describes evidence strength only. */
export type OptionsReliability = 'high' | 'moderate' | 'low';

/**
 * Truthful data-mode vocabulary shared with the market-source layer. REAL-TIME
 * is intentionally absent — the account is delayed/EOD and no path may claim it.
 */
export type OptionsDataMode = 'DELAYED' | 'END-OF-DAY' | 'CACHED' | 'STALE';

/** The typed reasons an Options S/R computation can be unavailable. */
export type OptionsSrUnavailableReason =
  /** Our own data contract with the provider does not cover options. */
  | 'entitlement-required'
  /**
   * The reader's PortKheaw plan does not include Options Walls. Kept distinct
   * from `entitlement-required` because the two are fixed by different people:
   * this one by the reader upgrading, the other by us.
   */
  | 'subscription-required'
  | 'no-expirations'
  | 'chain-unavailable'
  | 'insufficient-coverage'
  | 'stale'
  | 'rate-limited'
  | 'no-open-interest'
  | 'expired-expiration'
  | 'no-accepted-price';

/** Optional Greeks-weighted strike variants, populated only when real Greeks exist. */
export interface OptionsLevelGreekVariants {
  /** OI×|delta|-weighted mean strike of the cluster. */
  delta: number | null;
  /** OI×gamma-weighted mean strike of the cluster. */
  gamma: number | null;
}

export interface OptionsLevel {
  price: number;
  distancePercent: number;
  /** Open interest at the single peak strike of the cluster. */
  rawOI: number;
  /** Summed open interest across the clustered adjacent strikes. */
  clusterOI: number;
  /** clusterOI as a percentage of the side's total qualified OI. */
  oiSharePercent: number;
  method: OptionsLevelMethod;
  source: OptionsLevelSource;
  expiration: string;
  asOf: string;
  reliability: OptionsReliability;
  /** Present only when the whole cluster carried real Greeks. */
  greekVariants?: OptionsLevelGreekVariants;
}

export interface OptionsSrAvailable {
  status: 'available';
  symbol: string;
  expiration: string;
  acceptedPrice: number;
  callWall: OptionsLevel | null;
  putWall: OptionsLevel | null;
  maxPain: OptionsLevel | null;
  totalCallOI: number;
  totalPutOI: number;
  putCallOIRatio: number | null;
  /** Count of distinct strikes carrying at least one qualified contract. */
  strikeCoverage: number;
  /** Fraction [0,1] of qualified contracts that carry a finite open interest. */
  contractCoverage: number;
  provider: string;
  asOf: string;
  dataMode: OptionsDataMode;
  reliability: OptionsReliability;
  limitations: string[];
}

export interface OptionsSrUnavailable {
  status: 'unavailable';
  symbol: string;
  expiration: string | null;
  reason: OptionsSrUnavailableReason;
  message: string;
  provider: string | null;
  asOf: string | null;
  dataMode: OptionsDataMode | null;
  limitations: string[];
}

export type OptionsSrResult = OptionsSrAvailable | OptionsSrUnavailable;

/** Input for a single expiration, mapped from the existing OptionsChain contract. */
export interface OptionsSrInput {
  symbol: string;
  expiration: string;
  /** The single accepted underlying price (the same one the header/chart use). */
  acceptedPrice: number;
  calls: readonly OptionContract[];
  puts: readonly OptionContract[];
  provider: string;
  asOf: string;
  status: MarketDataStatus;
}

export interface OptionsSrConfig {
  /** Reject a chain with fewer distinct qualified strikes than this. */
  minStrikes: number;
  /** Reject when the fraction of qualified contracts carrying OI is below this. */
  minOiCoverage: number;
  /** Adjacent-strike cluster tolerance as a fraction of the accepted price. */
  clusterTolerancePercent: number;
  /** Distinct qualified strikes at which the strike-coverage reliability input saturates. */
  strikeCoverageSaturation: number;
  /** oiSharePercent at which the concentration-strength reliability input saturates. */
  concentrationSaturationPercent: number;
  /** Injected clock (ms) for deterministic freshness/expiration tests. */
  nowMs?: number;
}
