import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createFairValueUnavailable } from '@/src/lib/analytics/valuation/result';
import { calculateFairValue } from '@/src/lib/analytics/valuation/engine';
import type { ValuationInput } from '@/src/lib/analytics/valuation/types';
import {
  FairValueDetailsDrawer,
  normalizedDiagnostics,
} from './FairValueDetailsDrawer';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');
const input: ValuationInput = {
  symbol: 'NVDA',
  currency: 'USD',
  marketPrice: 120,
  priceAsOf: '2026-07-24T20:00:00.000Z',
  marketPriceSource: 'market-provider',
  marketCapitalization: 3_000,
  source: 'financial-modeling-prep',
  sourceType: 'provider-supplied',
  sector: 'Technology',
  industry: 'Semiconductors',
  periods: [{
    periodEnd: '2025-12-31', currency: 'USD', revenue: 1_000, operatingIncome: 300,
    netIncome: 220, incomeBeforeTax: 260, incomeTaxExpense: 42, depreciationAmortization: 30,
    capitalExpenditure: 50, changeInWorkingCapital: 10, operatingCashFlow: 260, freeCashFlow: 210,
    dividendsPaid: -5, interestExpense: 8, totalDebt: 100, cash: 300, totalAssets: 2_000,
    totalLiabilities: 500, dilutedShares: 100,
  }],
  historicalPrices: [],
  historySource: '',
  historyFreshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
  analystEstimates: [2026, 2027, 2028, 2029, 2030].map((year, index) => ({
    periodEnd: `${year}-12-31`,
    estimatedRevenue: 1_100 * (1.12 ** index),
    estimatedEps: 3 + index * 0.2,
    revenueAnalystCount: 20,
    epsAnalystCount: 20,
    provider: 'financial-modeling-prep',
    asOf: '2026-07-25T00:00:00.000Z',
  })),
  peerObservations: [20, 22, 24, 26].map((multiple, index) => ({
    symbol: `SEM${index + 1}`, sector: 'Technology', industry: 'Semiconductors',
    price: multiple * 3, priceAsOf: '2026-07-24T20:00:00.000Z',
    enterpriseValue: multiple * 100, enterpriseValueAsOf: '2026-06-30',
    forwardEps: 3, forwardRevenue: 100, estimatePeriod: '2026-12-31',
    estimateAsOf: '2026-07-25T00:00:00.000Z', provider: 'financial-modeling-prep',
  })),
  waccMarketInputs: {
    beta: 1.5, betaAsOf: '2026-07-25T00:00:00.000Z',
    riskFreeRate: 0.04, riskFreeAsOf: '2026-07-24',
    equityRiskPremium: 0.05, equityRiskPremiumAsOf: '2026-07-25T00:00:00.000Z',
    provider: 'financial-modeling-prep',
  },
  calculatedAt: '2026-07-25T00:00:00.000Z',
};

describe('Fair Value details rendering', () => {
  it('renders an NVDA-style Base result without crashing', () => {
    const result = calculateFairValue(input, NOW);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.fairValue).toMatchObject({
        type: 'base',
        label: 'Base Fair Value',
        confidence: 'High',
      });
    }
    const html = renderToStaticMarkup(
      <FairValueDetailsDrawer id="details" open onClose={() => undefined} data={result} unavailableReason={null} />,
    );
    expect(html).toContain('วิธีคำนวณ Fair Value');
    expect(html).toContain('Base');
    expect(html).toContain('Confidence');
  });

  it('renders an unavailable result without exposing an invented value', () => {
    const result = createFairValueUnavailable({
      failureKind: 'missing-field',
      symbol: 'RKLB',
      provider: 'financial-modeling-prep',
      reason: 'ขาดข้อมูลจริงที่จำเป็น',
      missingFields: ['beta', 'validForwardPeers>=4'],
      asOf: '2026-07-25T00:00:00.000Z',
      calculatedAt: '2026-07-25T00:00:00.000Z',
      limitations: ['No fallback.'],
      diagnostics: [],
    });
    const html = renderToStaticMarkup(
      <FairValueDetailsDrawer id="details" open onClose={() => undefined} data={result} unavailableReason={null} />,
    );
    expect(html).toContain('Unavailable');
    expect(html).toContain('ข้อมูลจริงไม่ผ่านเกณฑ์ขั้นต่ำ');
    expect(html).not.toContain('$0.00');
  });

  it('publishes one canonical UI state when a provider miss is later resolved', () => {
    const result = calculateFairValue({
      ...input,
      waccMarketInputs: {
        ...input.waccMarketInputs!,
        betaProvenance: {
          provider: 'nexora-historical-beta',
          sourceType: 'derived',
          field: 'beta',
          fiscalPeriod: '2026-01-02/2026-03-31',
          asOf: '2026-03-31',
          evidence: [],
          evidenceQuality: 'medium',
          methodology: 'OLS beta from aligned daily returns',
          benchmark: 'SPY',
          sampleSize: 89,
          frequency: 'daily',
          start: '2026-01-02',
          end: '2026-03-31',
        },
      },
      diagnostics: [
        {
          field: 'beta',
          value: null,
          period: 'latest profile',
          provider: 'financial-modeling-prep',
          asOf: '2026-07-25T00:00:00.000Z',
          status: 'missing',
          provenance: 'provider',
          reason: 'provider-field-missing',
        },
        {
          field: 'beta',
          value: 1.5,
          period: '2026-01-02/2026-03-31',
          provider: 'nexora-historical-beta',
          asOf: '2026-03-31',
          status: 'available',
          provenance: 'derived',
          sourceType: 'derived',
          reason: 'derived-historical-beta:SPY:89',
        },
      ],
    }, NOW);
    const diagnostics = normalizedDiagnostics(result);
    const beta = diagnostics.filter((item) =>
      item.field.toLowerCase().replace(/[^a-z]/g, '') === 'beta');
    expect(beta).toHaveLength(1);
    expect(beta[0]).toMatchObject({
      status: 'available',
      provenance: 'derived',
      value: 1.5,
    });
  });
});
