import { describe, expect, it } from 'vitest';
import { DATASET_FRESHNESS_POLICY, datasetFreshness } from './freshness';

describe('valuation dataset freshness policy', () => {
  it('defines an explicit independent policy for every production dataset', () => {
    expect(Object.keys(DATASET_FRESHNESS_POLICY).sort()).toEqual([
      'beta',
      'equityRiskPremium',
      'financialStatements',
      'forwardEstimates',
      'marketPrice',
      'peerEstimates',
      'riskFreeRate',
    ]);
    expect(DATASET_FRESHNESS_POLICY.financialStatements.basis)
      .toBe('latest-fiscal-period');
    expect(DATASET_FRESHNESS_POLICY.marketPrice.freshMs)
      .toBeLessThan(DATASET_FRESHNESS_POLICY.financialStatements.freshMs);
  });

  it('allows a latest official fiscal period as stale without treating fetchedAt as truth', () => {
    const now = Date.parse('2026-07-25T00:00:00.000Z');
    expect(datasetFreshness('financialStatements', '2024-12-31', now)).toBe('stale');
    expect(datasetFreshness('marketPrice', '2024-12-31', now)).toBe('expired');
  });
});
