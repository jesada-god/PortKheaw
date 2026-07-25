export type ValuationDataset =
  | 'marketPrice'
  | 'beta'
  | 'riskFreeRate'
  | 'equityRiskPremium'
  | 'financialStatements'
  | 'forwardEstimates'
  | 'peerEstimates';

export interface DatasetFreshnessPolicy {
  freshMs: number;
  staleMs: number;
  basis: 'observed-at' | 'latest-fiscal-period';
}

const DAY = 86_400_000;

/** Dataset-specific production freshness. Financial statements are intentionally
 * judged from the latest reported fiscal period, not merely from cache fetch time. */
export const DATASET_FRESHNESS_POLICY: Record<ValuationDataset, DatasetFreshnessPolicy> = {
  marketPrice: { freshMs: DAY, staleMs: 7 * DAY, basis: 'observed-at' },
  beta: { freshMs: 30 * DAY, staleMs: 180 * DAY, basis: 'observed-at' },
  riskFreeRate: { freshMs: 2 * DAY, staleMs: 14 * DAY, basis: 'observed-at' },
  equityRiskPremium: { freshMs: 30 * DAY, staleMs: 180 * DAY, basis: 'observed-at' },
  financialStatements: { freshMs: 550 * DAY, staleMs: 800 * DAY, basis: 'latest-fiscal-period' },
  forwardEstimates: { freshMs: 7 * DAY, staleMs: 180 * DAY, basis: 'observed-at' },
  peerEstimates: { freshMs: 7 * DAY, staleMs: 180 * DAY, basis: 'observed-at' },
};

export type DatasetFreshnessState = 'fresh' | 'stale' | 'expired' | 'missing';

export function datasetFreshness(
  dataset: ValuationDataset,
  asOf: string | null | undefined,
  now = Date.now(),
): DatasetFreshnessState {
  if (!asOf) return 'missing';
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp)) return 'missing';
  const age = now - timestamp;
  if (age < -DAY) return 'expired';
  const policy = DATASET_FRESHNESS_POLICY[dataset];
  if (age <= policy.freshMs) return 'fresh';
  if (age <= policy.staleMs) return 'stale';
  return 'expired';
}
