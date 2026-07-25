import { loadFairValue } from '../src/lib/analytics/valuation/orchestration';
import { datasetFreshness } from '../src/lib/analytics/valuation/freshness';
import type {
  FinancialPeriod,
  ValuationDiagnostic,
  WaccMarketInputs,
} from '../src/lib/analytics/valuation/types';

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,20}$/.test(symbol)) {
    console.error('Usage: npm run warm:fair-value -- NVDA');
    process.exitCode = 1;
    return;
  }
  const result = await loadFairValue(symbol);
  if (result.status === 'unavailable') {
    console.log(JSON.stringify({
      symbol,
      status: 'unavailable',
      failureKind: result.failureKind,
      provider: result.provider,
      reason: result.reason,
      missing: result.missingFields,
      diagnostics: result.diagnostics.filter((item) =>
        item.status === 'missing' || item.status === 'rejected'),
      calculatedAt: result.calculatedAt,
    }, null, 2));
    process.exitCode = 2;
  } else {
    const inputs = result.inputs as {
      latestPeriod?: FinancialPeriod | null;
      waccMarketInputs?: WaccMarketInputs | null;
      betaAudit?: {
        targetSource: string;
        benchmarkSource: string;
        targetRows: number;
        benchmarkRows: number;
        alignedRows: number;
        sampleSize: number;
        period: string | null;
        derivedBeta: number | null;
      } | null;
    };
    const wacc = inputs.waccMarketInputs ?? null;
    const diagnostic = (field: string): ValuationDiagnostic | null =>
      result.diagnostics.find((item) => item.field === field) ?? null;
    const dcf = result.modelResults.find((model) => model.model === 'fcff-dcf');
    const forwardPe = result.modelResults.find((model) => model.model === 'pe');
    const evSales = result.modelResults.find((model) => model.model === 'ev-sales');
    const modelReason = (field: string): string | null =>
      diagnostic(field)?.reason ?? null;
    const now = Date.parse(result.calculatedAt);

    console.log(JSON.stringify({
      symbol,
      riskFree: {
        value: wacc?.riskFreeRate ?? null,
        source: wacc?.riskFreeRateProvenance?.provider ?? wacc?.provider ?? null,
        asOf: wacc?.riskFreeAsOf ?? null,
        freshness: datasetFreshness('riskFreeRate', wacc?.riskFreeAsOf, now),
      },
      erp: {
        value: wacc?.equityRiskPremium ?? null,
        source: wacc?.equityRiskPremiumProvenance?.provider ?? wacc?.provider ?? null,
        asOf: wacc?.equityRiskPremiumAsOf ?? null,
        freshness: datasetFreshness(
          'equityRiskPremium',
          wacc?.equityRiskPremiumAsOf,
          now,
        ),
      },
      beta: {
        value: wacc?.beta ?? null,
        source: wacc?.betaProvenance?.provider ?? wacc?.provider ?? null,
        asOf: wacc?.betaAsOf ?? null,
        freshness: datasetFreshness('beta', wacc?.betaAsOf, now),
        ...inputs.betaAudit,
      },
      fcf: {
        value: inputs.latestPeriod?.freeCashFlow ?? null,
        source: diagnostic('freeCashFlow')?.provider ?? result.sources.at(0)?.name ?? null,
        asOf: inputs.latestPeriod?.periodEnd ?? null,
      },
      dcf: dcf ? {
        status: 'PASS',
        wacc: dcf.assumptions.wacc ?? null,
        fairValue: dcf.fairValue,
        growthMethod: dcf.inputs.growthMethod ?? null,
      } : {
        status: 'FAIL',
        reason: modelReason('model:fcff-dcf'),
      },
      forwardPe: forwardPe ? {
        status: 'PASS',
        fairValue: forwardPe.fairValue,
      } : {
        status: 'FAIL',
        reason: modelReason('model:forward-pe')
          ?? modelReason('model:forward-multiples'),
      },
      evSales: evSales ? {
        status: 'PASS',
        fairValue: evSales.fairValue,
      } : {
        status: 'FAIL',
        reason: modelReason('model:forward-ev-sales')
          ?? modelReason('model:forward-multiples'),
      },
      final: {
        type: result.fairValue.type,
        label: result.fairValue.label,
        value: result.fairValue.value,
        baseStatus: result.baseStatus,
      },
      providers: {
        dataStatus: result.dataStatus,
        geminiRequests: result.researchAudit?.requests ?? 0,
        geminiRejectedReasons: result.researchAudit?.rejectedReasons ?? [],
        rateLimitedDiagnostics: result.diagnostics
          .filter((item) => /rate.?limit|429/i.test(item.reason ?? ''))
          .map((item) => ({
            field: item.field,
            provider: item.provider,
            reason: item.reason,
          })),
      },
      calculatedAt: result.calculatedAt,
    }, null, 2));
  }
}

void main().catch((cause: unknown) => {
  console.error(JSON.stringify({
    status: 'error',
    errorCode: cause instanceof Error ? cause.name : 'unknown-error',
  }));
  process.exitCode = 2;
});
