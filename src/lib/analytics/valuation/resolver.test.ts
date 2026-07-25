import { describe, expect, it } from 'vitest';
import type { HistoricalPrice } from '@/src/lib/market-data/types';
import {
  classifyValuationInputs,
  deriveHistoricalBeta,
  normalizePercentage,
  resolveDeterministicInputs,
  resolveHistoricalBeta,
} from './resolver';

function history(multiplier: number, count = 90): HistoricalPrice[] {
  let close = 100;
  return Array.from({ length: count }, (_, index) => {
    const benchmarkMove = ((index % 7) - 3) / 1_000;
    close *= Math.exp(benchmarkMove * multiplier);
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, volume: 1_000 };
  });
}

describe('Fair Value missing-input resolver', () => {
  it('classifies provider, derivable, researchable, and truly missing inputs', () => {
    const result = classifyValuationInputs({
      marketPrice: 20,
      marketCapitalization: null,
      sharesOutstanding: 100,
      dilutedShares: null,
      analystEstimates: [],
      peers: [],
      waccMarketInputs: {
        beta: null,
        betaAsOf: null,
        riskFreeRate: null,
        riskFreeAsOf: null,
        equityRiskPremium: null,
        equityRiskPremiumAsOf: null,
        provider: 'provider',
      },
    });
    expect(result.available).toEqual(expect.arrayContaining(['marketPrice', 'shares']));
    expect(result.derivable).toEqual(expect.arrayContaining(['marketCapitalization', 'beta']));
    expect(result.researchable).toEqual(expect.arrayContaining([
      'riskFreeRate',
      'equityRiskPremium',
      'forwardRevenue',
      'forwardEps',
      'peerForwardEstimates',
    ]));
    expect(result.missing).toEqual([]);
  });

  it('derives beta from aligned stock and benchmark returns with audit metadata', () => {
    const result = deriveHistoricalBeta(history(1.5), history(1), {
      stockProvider: 'stock-history',
      benchmarkProvider: 'benchmark-history',
      benchmark: 'SPY',
    });
    expect(result?.value).toBeCloseTo(1.5, 6);
    expect(result?.provenance).toMatchObject({
      sourceType: 'derived',
      benchmark: 'SPY',
      sampleSize: 89,
      frequency: 'daily',
      start: '2026-01-02',
      end: '2026-03-31',
    });
  });

  it('refuses a beta with too few observations and never substitutes a default', () => {
    const result = resolveHistoricalBeta(history(1.2, 20), history(1, 20), {
      stockProvider: 'stock-history',
      benchmarkProvider: 'benchmark-history',
    });
    expect(result.beta).toBeNull();
    expect(result.audit).toMatchObject({
      targetRows: 20,
      benchmarkRows: 20,
      alignedObservations: 19,
      minimumSamples: 60,
      frequency: 'daily',
      reason: 'insufficient-aligned-observations',
      derivedBeta: null,
    });
  });

  it('derives market cap only when the authoritative field is absent', () => {
    const derived = resolveDeterministicInputs({
      marketPrice: 20,
      priceAsOf: '2026-07-25',
      marketPriceProvider: 'quote-provider',
      marketCapitalization: null,
      shares: 100,
      sharesAsOf: '2026-06-30',
      sharesProvider: 'statement-provider',
    });
    expect(derived.marketCapitalization).toBe(2_000);
    expect(derived.marketCapitalizationProvenance).toMatchObject({
      sourceType: 'derived',
      field: 'marketCapitalization',
    });

    const authoritative = resolveDeterministicInputs({
      marketPrice: 20,
      priceAsOf: '2026-07-25',
      marketPriceProvider: 'quote-provider',
      marketCapitalization: 2_100,
      shares: 100,
      sharesAsOf: '2026-06-30',
      sharesProvider: 'statement-provider',
    });
    expect(authoritative.marketCapitalization).toBe(2_100);
    expect(authoritative.marketCapitalizationProvenance).toBeNull();
  });

  it('normalizes explicitly labelled percentages once and rejects ambiguous ranges', () => {
    expect(normalizePercentage('4.25%', 'percent', { maximum: 0.25 })).toBe(0.0425);
    expect(normalizePercentage(4.25, 'percent', { maximum: 0.25 })).toBe(0.0425);
    expect(normalizePercentage(0.0425, 'decimal', { maximum: 0.25 })).toBe(0.0425);
    expect(normalizePercentage(4.25, 'decimal', { maximum: 0.25 })).toBeNull();
    expect(normalizePercentage(0.0425, 'percent', { maximum: 0.25 }))
      .toBeCloseTo(0.000425);
  });
});
