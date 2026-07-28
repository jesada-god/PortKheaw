/**
 * Next scheduled earnings report for one symbol.
 *
 * Event risk is the only Options Signal input that is neither a price nor an
 * options quantity, so it gets its own tiny provider chain. Nothing here is ever
 * estimated: a symbol with no scheduled report returns a typed unavailable
 * state, never "0 days" or a guessed quarter-end.
 */

export type EarningsProviderId = 'alpha-vantage' | 'financial-modeling-prep';

/** When in the session the company reports, as dated by the provider. */
export type EarningsTimeOfDay = 'pre-market' | 'post-market' | 'unknown';

export type EarningsUnavailableReason =
  | 'not-configured'
  | 'no-scheduled-report'
  | 'entitlement-unavailable'
  | 'rate-limited'
  | 'provider-unavailable';

export interface EarningsScheduleAvailable {
  status: 'available';
  symbol: string;
  /** Exchange-local (America/New_York) report date, `YYYY-MM-DD`. */
  reportDate: string;
  timeOfDay: EarningsTimeOfDay;
  /** Consensus EPS estimate when the provider published one. Never derived. */
  epsEstimate: number | null;
  /** Whole calendar days from the evaluation date to `reportDate`; 0 = today. */
  daysToEarnings: number;
  provider: EarningsProviderId;
  asOf: string;
  /** True when the value came from cache after a provider failure. */
  stale: boolean;
}

export interface EarningsScheduleUnavailable {
  status: 'unavailable';
  symbol: string;
  reason: EarningsUnavailableReason;
  message: string;
  provider: EarningsProviderId | null;
  asOf: string | null;
}

export type EarningsSchedule = EarningsScheduleAvailable | EarningsScheduleUnavailable;

/** One provider row after parsing, before "which one is next" is decided. */
export interface EarningsCandidate {
  symbol: string;
  reportDate: string;
  timeOfDay: EarningsTimeOfDay;
  epsEstimate: number | null;
}
