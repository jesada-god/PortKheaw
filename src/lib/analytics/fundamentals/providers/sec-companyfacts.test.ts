import { describe, expect, it, vi } from 'vitest';
import { SecCompanyFactsFundamentalsProvider } from './sec-companyfacts';

vi.mock('server-only', () => ({}));

const duration = {
  val: 1,
  start: '2024-01-01',
  end: '2024-12-31',
  filed: '2025-02-20',
  form: '10-K',
  fy: 2024,
  fp: 'FY',
  accn: '0000000000-25-000001',
};
const instant = {
  ...duration,
  start: undefined,
};

function concept(unit: 'USD' | 'shares' | 'USD/shares', value: number, isInstant = false) {
  return { units: { [unit]: [{ ...(isInstant ? instant : duration), val: value }] } };
}

describe('SEC Company Facts fundamentals fallback', () => {
  it('normalizes only structured 10-K US-GAAP facts into the existing period contract', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        0: { ticker: 'XYZ', cik_str: 1234, title: 'XYZ Inc.' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        cik: 1234,
        entityName: 'XYZ Inc.',
        facts: {
          'us-gaap': {
            Revenues: concept('USD', 1_000),
            OperatingIncomeLoss: concept('USD', 200),
            NetIncomeLoss: concept('USD', 120),
            InterestExpenseNonOperating: concept('USD', 10),
            WeightedAverageNumberOfDilutedSharesOutstanding: concept('shares', 50),
            Assets: concept('USD', 2_000, true),
            Liabilities: concept('USD', 800, true),
            CashAndCashEquivalentsAtCarryingValue: concept('USD', 150, true),
            LongTermDebtCurrentAndNoncurrent: concept('USD', 300, true),
            EntityCommonStockSharesOutstanding: concept('shares', 50, true),
            NetCashProvidedByUsedInOperatingActivities: concept('USD', 180),
            PaymentsToAcquirePropertyPlantAndEquipment: concept('USD', 30),
            DepreciationDepletionAndAmortization: concept('USD', 20),
          },
        },
      }), { status: 200 }));
    const provider = new SecCompanyFactsFundamentalsProvider(
      'Nexora AI ops@example.com',
      fetcher,
      () => Date.parse('2025-02-21T00:00:00.000Z'),
    );
    const result = await provider.getFinancialPeriods('xyz');
    expect(result.providerUsed).toBe('sec-companyfacts');
    expect(result.dataState).toBe('authoritative-filing');
    expect(result.periods).toEqual([
      expect.objectContaining({
        periodEnd: '2024-12-31',
        currency: 'USD',
        revenue: 1_000,
        freeCashFlow: 150,
        cash: 150,
        totalDebt: 300,
        dilutedShares: 50,
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'User-Agent': 'Nexora AI ops@example.com' }),
    }));
  });
});
