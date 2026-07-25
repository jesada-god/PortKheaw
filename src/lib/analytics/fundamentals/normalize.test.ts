import { describe, expect, it } from 'vitest';
import { normalizeFinancialStatements, safeNumber, workingCapitalChange, type RawReport } from './normalize';

function rows(dates: string[], kind: 'income' | 'balance' | 'cash'): RawReport[] {
  return dates.map((fiscalDateEnding, index) => {
    if (kind === 'income') return { fiscalDateEnding, reportedCurrency: 'USD', fiscalPeriod: `Q${index + 1}`, totalRevenue: '1000', operatingIncome: '200', netIncome: '100', interestExpense: '10', dilutedAverageShares: '50', dilutedEPS: String(index + 1) };
    if (kind === 'balance') return { fiscalDateEnding, reportedCurrency: 'USD', cashAndCashEquivalentsAtCarryingValue: '100', shortLongTermDebtTotal: '200', totalAssets: '2000', totalLiabilities: '800' };
    return { fiscalDateEnding, reportedCurrency: 'USD', operatingCashflow: '180', capitalExpenditures: '30', depreciationDepletionAndAmortization: '20', changeInOperatingLiabilities: '15', changeInOperatingAssets: '5', dividendPayoutCommonStock: '-10' };
  });
}
function payload(annual: RawReport[], quarterly: RawReport[]) { return { annualReports: annual, quarterlyReports: quarterly }; }

describe('fundamentals normalization', () => {
  it('treats None, empty, null, NaN and Infinity as unavailable rather than zero', () => {
    for (const value of ['None', '-', '', null, undefined, 'NaN', 'Infinity']) expect(safeNumber(value)).toBeNull();
    expect(safeNumber('1,234.5')).toBe(1234.5);
    expect(safeNumber('(1.25e3)')).toBe(-1250);
  });

  it('normalizes working-capital sign once and derives only from complete real components', () => {
    expect(workingCapitalChange({ changeInOperatingAssets: '30', changeInOperatingLiabilities: '10' })).toBe(20);
    expect(workingCapitalChange({ changeInWorkingCapital: '-25' })).toBe(25);
    const previous = { currentNetReceivables: '100', inventory: '50', otherCurrentAssets: '10', currentAccountsPayable: '40', otherCurrentLiabilities: '20' };
    const current = { currentNetReceivables: '120', inventory: '55', otherCurrentAssets: '10', currentAccountsPayable: '45', otherCurrentLiabilities: '20' };
    expect(workingCapitalChange({}, current, previous)).toBe(20);
    expect(workingCapitalChange({}, { ...current, inventory: 'None' }, previous)).toBeNull();
  });
  it('separates and orders annual/quarterly periods and calculates diluted EPS TTM only from four complete quarters', () => {
    const annualDates = ['2024-12-31', '2023-12-31']; const quarterDates = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31'];
    const result = normalizeFinancialStatements('xyz', payload(rows(annualDates, 'income'), rows(quarterDates, 'income')), payload(rows(annualDates, 'balance'), rows(quarterDates, 'balance')), payload(rows(annualDates, 'cash'), rows(quarterDates, 'cash')), { source: 'test', fetchedAt: '2025-01-01T00:00:00.000Z' });
    expect(result.annual.map((row) => row.periodEnd)).toEqual(['2023-12-31', '2024-12-31']);
    expect(result.quarterly).toHaveLength(4); expect(result.dilutedEpsTtm).toBe(10);
    expect(result.quarterlyRecords[0]).toMatchObject({ frequency: 'quarterly', source: 'test', currency: 'USD' });
  });
  it('derives dilutedShares from the balance-sheet shares outstanding when the income statement omits a share count', () => {
    // Mirrors the real Alpha Vantage schema: INCOME_STATEMENT carries no share
    // count, while BALANCE_SHEET exposes commonStockSharesOutstanding. Without the
    // fallback every period is dropped as "missing dilutedShares" (the Fair Value
    // mapping-error root cause).
    const annualDates = ['2024-12-31', '2023-12-31', '2022-12-31'];
    const income = annualDates.map((fiscalDateEnding, index) => ({ fiscalDateEnding, reportedCurrency: 'USD', totalRevenue: '1000', operatingIncome: '200', netIncome: '100', interestExpense: '10', dilutedEPS: String(index + 1) }));
    const balance = annualDates.map((fiscalDateEnding) => ({ fiscalDateEnding, reportedCurrency: 'USD', cashAndCashEquivalentsAtCarryingValue: '100', shortLongTermDebtTotal: '200', totalAssets: '2000', totalLiabilities: '800', commonStockSharesOutstanding: '50' }));
    const cash = annualDates.map((fiscalDateEnding) => ({ fiscalDateEnding, reportedCurrency: 'USD', operatingCashflow: '180', capitalExpenditures: '30', depreciationDepletionAndAmortization: '20', changeInOperatingLiabilities: '15', changeInOperatingAssets: '5' }));
    const result = normalizeFinancialStatements('SHR', payload(income, []), payload(balance, []), payload(cash, []), { source: 'test', fetchedAt: '2025-01-01T00:00:00.000Z' });
    expect(result.annual).toHaveLength(3);
    expect(result.annual.every((period) => period.dilutedShares === 50)).toBe(true);
    expect(result.missingInputs.some((value) => value.includes('dilutedShares'))).toBe(false);
  });

  it('detects duplicate periods, incomplete aligned statements and currency mismatch', () => {
    const dates = ['2024-12-31']; const duplicateIncome = [...rows(dates, 'income'), ...rows(dates, 'income')];
    const balance = rows(dates, 'balance'); balance[0].reportedCurrency = 'EUR';
    const result = normalizeFinancialStatements('XYZ', payload(duplicateIncome, []), payload(balance, []), payload([], []));
    expect(result.annual).toHaveLength(0);
    expect(result.missingInputs.some((value) => value.includes('duplicate:income-statement'))).toBe(true);
    expect(result.missingInputs).toContain('annual:2024-12-31:alignedStatements');
    expect(result.missingInputs).toContain('annual:2024-12-31:currency');
  });

  it('does not derive TTM from duplicate or non-contiguous quarters', () => {
    const quarterDates = ['2023-03-31', '2023-06-30', '2024-09-30', '2024-12-31'];
    const result = normalizeFinancialStatements(
      'GAP',
      payload([], rows(quarterDates, 'income')),
      payload([], rows(quarterDates, 'balance')),
      payload([], rows(quarterDates, 'cash')),
    );
    expect(result.dilutedEpsTtm).toBeNull();
    expect(result.missingInputs).toContain('dilutedEpsTtm:fourCompleteQuarterlyPeriods');
  });
});

