import type { FinancialPeriod } from '../valuation/types';
import { normalizeCapitalExpenditure } from '../valuation/formulas';

export type ReportingFrequency = 'annual' | 'quarterly';
export type DatasetName = 'income-statement' | 'balance-sheet' | 'cash-flow';
export interface RawReport { [key: string]: unknown }
export interface RawStatementPayload { symbol?: unknown; annualReports?: unknown; quarterlyReports?: unknown }
export type ReportedValue = { status: 'available'; value: number } | { status: 'unavailable'; value: null };
export interface NormalizedFinancialRecord {
  fiscalPeriod: string;
  fiscalYear: number;
  periodEnd: string;
  filingDate: string | null;
  currency: string | null;
  frequency: ReportingFrequency;
  source: string;
  fetchedAt: string;
  values: Record<string, ReportedValue>;
}

export interface NormalizedStatements {
  symbol: string;
  currency: string;
  annual: FinancialPeriod[];
  quarterly: FinancialPeriod[];
  annualRecords: NormalizedFinancialRecord[];
  quarterlyRecords: NormalizedFinancialRecord[];
  dilutedEpsTtm: number | null;
  dilutedEpsAsOf: string | null;
  missingInputs: string[];
}

const EMPTY_VALUES = new Set(['', '-', 'none', 'null', 'n/a']);

export function safeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || EMPTY_VALUES.has(value.trim().toLowerCase())) return null;
  const trimmed = value.trim();
  const negativeParentheses = /^\((.*)\)$/.exec(trimmed);
  const normalized = (negativeParentheses?.[1] ?? trimmed).replaceAll(',', '').trim();
  const parsed = Number(normalized) * (negativeParentheses ? -1 : 1);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && !EMPTY_VALUES.has(result.toLowerCase()) ? result : null;
}

function reports(payload: RawStatementPayload, frequency: ReportingFrequency): RawReport[] {
  const value = frequency === 'annual' ? payload.annualReports : payload.quarterlyReports;
  return Array.isArray(value) ? value.filter((row): row is RawReport => Boolean(row) && typeof row === 'object' && !Array.isArray(row)) : [];
}

function keyed(payload: RawStatementPayload, frequency: ReportingFrequency, missing?: Set<string>, dataset = 'statement'): Map<string, RawReport> {
  const result = new Map<string, RawReport>();
  for (const report of reports(payload, frequency)) {
    const end = text(report.fiscalDateEnding);
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      if (result.has(end)) missing?.add(`${frequency}:${end}:duplicate:${dataset}`);
      else result.set(end, report);
    }
  }
  return result;
}

function firstNumber(report: RawReport, fields: string[]): number | null {
  for (const field of fields) {
    const value = safeNumber(report[field]);
    if (value !== null) return value;
  }
  return null;
}

function combineDebt(report: RawReport): number | null {
  const direct = firstNumber(report, ['shortLongTermDebtTotal', 'totalDebt']);
  if (direct !== null) return direct;
  const current = firstNumber(report, ['currentDebt', 'shortTermDebt']);
  const longTerm = firstNumber(report, ['longTermDebtNoncurrent', 'longTermDebt']);
  return current !== null && longTerm !== null ? current + longTerm : null;
}

function sumRequired(report: RawReport, fields: readonly string[]): number | null {
  const values = fields.map((field) => safeNumber(report[field]));
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function operatingWorkingCapital(report: RawReport): number | null {
  const directAssets = firstNumber(report, ['totalOperatingCurrentAssets', 'nonCashCurrentAssets']);
  const directLiabilities = firstNumber(report, ['totalOperatingCurrentLiabilities', 'nonDebtCurrentLiabilities']);
  const assets = directAssets ?? sumRequired(report, ['currentNetReceivables', 'inventory', 'otherCurrentAssets']);
  const liabilities = directLiabilities ?? sumRequired(report, ['currentAccountsPayable', 'otherCurrentLiabilities']);
  return assets !== null && liabilities !== null ? assets - liabilities : null;
}

/** Positive means an operating working-capital investment that reduces forecast FCF. */
export function workingCapitalChange(report: RawReport, balance: RawReport = {}, previousBalance: RawReport | null = null): number | null {
  const cashFlowImpact = firstNumber(report, ['changeInWorkingCapital', 'changesInOperatingAssetsAndLiabilities']);
  if (cashFlowImpact !== null) return -cashFlowImpact;
  const liabilities = firstNumber(report, ['changeInOperatingLiabilities', 'changeInCurrentLiabilities']);
  const assets = firstNumber(report, ['changeInOperatingAssets', 'changeInCurrentAssets']);
  if (liabilities !== null && assets !== null) return assets - liabilities;
  const current = operatingWorkingCapital(balance);
  const previous = previousBalance ? operatingWorkingCapital(previousBalance) : null;
  return current !== null && previous !== null ? current - previous : null;
}

function fields(i: RawReport, b: RawReport, c: RawReport, previousBalance: RawReport | null) {
  const operatingCashFlow = safeNumber(c.operatingCashflow); const capitalExpenditure = safeNumber(c.capitalExpenditures);
  const operatingIncome = firstNumber(i, ['operatingIncome', 'ebit']);
  const depreciationAmortization = firstNumber(c, ['depreciationDepletionAndAmortization', 'depreciation']);
  const reportedEbitda = safeNumber(i.ebitda);
  return {
    revenue: safeNumber(i.totalRevenue),
    grossProfit: safeNumber(i.grossProfit),
    operatingIncome,
    ebitda: reportedEbitda ?? (operatingIncome !== null && depreciationAmortization !== null ? operatingIncome + depreciationAmortization : null),
    netIncome: safeNumber(i.netIncome),
    incomeBeforeTax: firstNumber(i, ['incomeBeforeTax', 'incomeBeforeTaxExpense']),
    incomeTaxExpense: firstNumber(i, ['incomeTaxExpense', 'incomeTaxExpenseBenefit']),
    dilutedEps: safeNumber(i.dilutedEPS),
    depreciationAmortization,
    capitalExpenditure,
    changeInWorkingCapital: workingCapitalChange(c, b, previousBalance),
    operatingCashFlow,
    freeCashFlow: operatingCashFlow !== null && capitalExpenditure !== null ? operatingCashFlow - normalizeCapitalExpenditure(capitalExpenditure) : null,
    dividendsPaid: firstNumber(c, ['dividendPayoutCommonStock', 'dividendPayout']),
    interestExpense: safeNumber(i.interestExpense),
    totalDebt: combineDebt(b),
    cash: firstNumber(b, ['cashAndCashEquivalentsAtCarryingValue', 'cashAndShortTermInvestments']),
    totalAssets: safeNumber(b.totalAssets),
    totalLiabilities: safeNumber(b.totalLiabilities),
    totalEquity: firstNumber(b, ['totalShareholderEquity', 'totalStockholderEquity']),
    // Alpha Vantage's INCOME_STATEMENT carries no share count; the diluted/weighted
    // fields only exist for other vendors. Fall back to the balance sheet's
    // period-end shares outstanding (the sole share figure Alpha Vantage returns)
    // so real filings are not dropped as "missing dilutedShares". This is a field
    // mapping only — no valuation formula changes.
    dilutedShares: firstNumber(i, ['dilutedAverageShares', 'weightedAverageDilutedSharesOutstanding', 'weightedAverageShsOutDil'])
      ?? firstNumber(b, ['commonStockSharesOutstanding', 'commonStockSharesOutstandingDiluted']),
  };
}

function normalizeFrequency(income: RawStatementPayload, balance: RawStatementPayload, cashFlow: RawStatementPayload, frequency: ReportingFrequency, missing: Set<string>, source: string, fetchedAt: string): { periods: FinancialPeriod[]; records: NormalizedFinancialRecord[] } {
  const incomes = keyed(income, frequency, missing, 'income-statement'); const balances = keyed(balance, frequency, missing, 'balance-sheet'); const cashFlows = keyed(cashFlow, frequency, missing, 'cash-flow');
  const periods: FinancialPeriod[] = [];
  const records: NormalizedFinancialRecord[] = [];
  const orderedIncomes = [...incomes].sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [periodEnd, i]] of orderedIncomes.entries()) {
    const b = balances.get(periodEnd) ?? {}; const c = cashFlows.get(periodEnd) ?? {};
    if (!balances.has(periodEnd) || !cashFlows.has(periodEnd)) missing.add(`${frequency}:${periodEnd}:alignedStatements`);
    const currencies = [text(i.reportedCurrency), text(b.reportedCurrency), text(c.reportedCurrency)].filter((v): v is string => Boolean(v));
    const currency = currencies.length && new Set(currencies).size === 1 ? currencies[0] : null;
    if (!currency) missing.add(`${frequency}:${periodEnd}:currency`);
    const previousPeriod = orderedIncomes[index - 1]?.[0];
    const previousBalance = previousPeriod ? balances.get(previousPeriod) ?? null : null;
    const values = fields(i, b, c, previousBalance);
    const fiscalYear = safeNumber(i.fiscalYear);
    records.push({ fiscalPeriod: frequency === 'annual' ? 'FY' : text(i.fiscalPeriod) ?? 'quarter', fiscalYear: fiscalYear !== null && Number.isInteger(fiscalYear) ? fiscalYear : Number(periodEnd.slice(0, 4)), periodEnd, filingDate: text(i.filingDate ?? i.reportedDate), currency, frequency, source, fetchedAt, values: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value === null ? { status: 'unavailable', value: null } : { status: 'available', value }])) });
    const optionalFields = new Set(['dividendsPaid', 'grossProfit', 'ebitda', 'dilutedEps', 'totalEquity', 'changeInWorkingCapital', 'incomeBeforeTax', 'incomeTaxExpense']);
    const absent = Object.entries(values).filter(([name, value]) => value === null && !optionalFields.has(name)).map(([name]) => name);
    if (absent.length || !currency) { absent.forEach((name) => missing.add(`${frequency}:${periodEnd}:${name}`)); continue; }
    periods.push({ periodEnd, currency, ...(values as Omit<FinancialPeriod, 'periodEnd' | 'currency'>) });
  }
  return { periods: periods.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)), records: records.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)) };
}

export function normalizeFinancialStatements(symbol: string, income: RawStatementPayload, balance: RawStatementPayload, cashFlow: RawStatementPayload, metadata: { source?: string; fetchedAt?: string } = {}): NormalizedStatements {
  const missing = new Set<string>();
  const fetchedAt = metadata.fetchedAt ?? new Date(0).toISOString(); const source = metadata.source ?? 'unknown-provider';
  const annualResult = normalizeFrequency(income, balance, cashFlow, 'annual', missing, source, fetchedAt);
  const quarterlyResult = normalizeFrequency(income, balance, cashFlow, 'quarterly', missing, source, fetchedAt);
  const annual = annualResult.periods; const quarterly = quarterlyResult.periods;
  const quarterlyIncome = [...keyed(income, 'quarterly')].sort(([a], [b]) => a.localeCompare(b));
  const latestFour = quarterlyIncome.slice(-4);
  const epsRows = latestFour.map(([periodEnd, row]) => ({ periodEnd, currency: text(row.reportedCurrency), value: safeNumber(row.dilutedEPS) }));
  const epsCurrencies = new Set(epsRows.map((row) => row.currency).filter(Boolean));
  const completeQuarterSequence = epsRows.length === 4
    && new Set(epsRows.map((row) => row.periodEnd)).size === 4
    && epsRows.slice(1).every((row, index) => {
      const days = (Date.parse(row.periodEnd) - Date.parse(epsRows[index].periodEnd)) / 86_400_000;
      return days >= 60 && days <= 120;
    })
    && !epsRows.some((row) =>
      missing.has(`quarterly:${row.periodEnd}:duplicate:income-statement`));
  const dilutedEpsTtm = completeQuarterSequence && epsRows.every((row) => row.value !== null) && epsCurrencies.size === 1
    ? epsRows.reduce((sum, row) => sum + row.value!, 0) : null;
  if (dilutedEpsTtm === null) missing.add('dilutedEpsTtm:fourCompleteQuarterlyPeriods');
  const allCurrencies = [...annual, ...quarterly].map((period) => period.currency);
  const currency = allCurrencies.at(-1) ?? (epsCurrencies.size === 1 ? [...epsCurrencies][0]! : '');
  return { symbol: symbol.toUpperCase(), currency, annual, quarterly, annualRecords: annualResult.records, quarterlyRecords: quarterlyResult.records, dilutedEpsTtm, dilutedEpsAsOf: dilutedEpsTtm === null ? null : epsRows.at(-1)!.periodEnd, missingInputs: [...missing].sort() };
}
