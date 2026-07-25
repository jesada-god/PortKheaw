import { z } from 'zod';
import type { FundamentalsSnapshot } from './provider';

const finiteNumber = z.number().finite();
const nullableFiniteNumber = finiteNumber.nullable();
const financialPeriodSchema = z.object({
  periodEnd: z.iso.date(),
  currency: z.string().trim().min(3).max(3),
  revenue: finiteNumber,
  operatingIncome: finiteNumber,
  netIncome: finiteNumber,
  depreciationAmortization: finiteNumber,
  capitalExpenditure: finiteNumber,
  changeInWorkingCapital: nullableFiniteNumber,
  operatingCashFlow: finiteNumber,
  freeCashFlow: finiteNumber,
  dividendsPaid: nullableFiniteNumber,
  interestExpense: finiteNumber,
  totalDebt: finiteNumber.nonnegative(),
  cash: finiteNumber.nonnegative(),
  totalAssets: finiteNumber.nonnegative(),
  totalLiabilities: finiteNumber.nonnegative(),
  dilutedShares: finiteNumber.positive(),
  incomeBeforeTax: nullableFiniteNumber.optional(),
  incomeTaxExpense: nullableFiniteNumber.optional(),
  grossProfit: nullableFiniteNumber.optional(),
  ebitda: nullableFiniteNumber.optional(),
  dilutedEps: nullableFiniteNumber.optional(),
  totalEquity: nullableFiniteNumber.optional(),
  restated: z.boolean().optional(),
});

const recordSchema = z.object({
  fiscalPeriod: z.string(),
  fiscalYear: z.number().int(),
  periodEnd: z.iso.date(),
  filingDate: z.iso.date().nullable(),
  currency: z.string().nullable(),
  frequency: z.enum(['annual', 'quarterly']),
  source: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  values: z.record(z.string(), z.object({
    status: z.enum(['available', 'unavailable']),
    value: finiteNumber.nullable(),
  })),
});

export const fundamentalsSnapshotSchema = z.object({
  symbol: z.string().trim().min(1),
  periods: z.array(financialPeriodSchema),
  quarterlyPeriods: z.array(financialPeriodSchema),
  annualRecords: z.array(recordSchema),
  quarterlyRecords: z.array(recordSchema),
  asOf: z.iso.date(),
  fetchedAt: z.iso.datetime(),
  currency: z.string(),
  dilutedEpsTtm: finiteNumber.nullable(),
  dilutedEpsAsOf: z.iso.date().nullable(),
  missingInputs: z.array(z.string()),
  datasetErrors: z.record(z.string(), z.string()),
  diagnostics: z.object({
    provider: z.string(),
    capabilities: z.array(z.string()),
    datasets: z.record(z.string(), z.enum(['available', 'unavailable'])),
    cache: z.record(z.string(), z.enum(['hit', 'miss', 'stale'])),
    datasetFetchedAt: z.record(z.string(), z.string().nullable()),
    latencyMs: finiteNumber.nonnegative(),
    normalizedPeriodCount: z.object({
      annual: z.number().int().nonnegative(),
      quarterly: z.number().int().nonnegative(),
    }),
  }),
  primaryProvider: z.string().optional(),
  providerUsed: z.string().optional(),
  fallbackUsed: z.boolean().optional(),
  fallbackReason: z.string().nullable().optional(),
  dataState: z.enum([
    'provider-live',
    'provider-cached',
    'provider-stale',
    'authoritative-filing',
  ]).optional(),
}).strict();

export interface FundamentalsValidation {
  valid: boolean;
  reasons: string[];
}

function validatePeriods(
  periods: FundamentalsSnapshot['periods'],
  frequency: 'annual' | 'quarterly',
): string[] {
  const reasons: string[] = [];
  const dates = periods.map((period) => period.periodEnd);
  if (new Set(dates).size !== dates.length) reasons.push(`${frequency}:duplicate-periods`);
  const currencies = new Set(periods.map((period) => period.currency));
  if (currencies.size > 1) reasons.push(`${frequency}:currency-mismatch`);
  if (dates.some((date, index) => index > 0 && date <= dates[index - 1])) {
    reasons.push(`${frequency}:periods-not-strictly-ordered`);
  }
  return reasons;
}

/** A snapshot may replace LKG only after schema and cross-period validation. */
export function validateFundamentalsSnapshot(
  snapshot: unknown,
  expectedSymbol?: string,
): FundamentalsValidation {
  const parsed = fundamentalsSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return {
      valid: false,
      reasons: parsed.error.issues.map((issue) =>
        `${issue.path.join('.') || 'snapshot'}:${issue.message}`),
    };
  }
  const value = parsed.data;
  const reasons = [
    ...validatePeriods(value.periods, 'annual'),
    ...validatePeriods(value.quarterlyPeriods, 'quarterly'),
  ];
  if (!value.periods.length) reasons.push('annual:no-usable-periods');
  if (expectedSymbol && value.symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
    reasons.push('symbol:mismatch');
  }
  if (value.periods.some((period) => period.currency !== value.currency)) {
    reasons.push('snapshot:currency-mismatch');
  }
  const annualDates = new Set(value.annualRecords.map((record) => record.periodEnd));
  if (value.annualRecords.length > 0
    && value.periods.some((period) => !annualDates.has(period.periodEnd))) {
    reasons.push('annual:record-alignment');
  }
  return { valid: reasons.length === 0, reasons };
}
