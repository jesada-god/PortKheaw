import 'server-only';
import { MarketDataError } from '@/src/lib/market-data/errors';
import {
  normalizeFinancialStatements,
  type RawReport,
  type RawStatementPayload,
} from '../normalize';
import type { FundamentalsProvider, FundamentalsSnapshot } from '../provider';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const COMPANY_FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const TIMEOUT_MS = 10_000;
const CACHE_MS = 24 * 60 * 60_000;

type Frequency = 'annual' | 'quarterly';
type Statement = 'income' | 'balance' | 'cash';
type UnitKind = 'USD' | 'shares' | 'USD/shares';

interface Fact {
  val: number;
  start?: string;
  end: string;
  filed: string;
  form: string;
  fy?: number;
  fp?: string;
  accn?: string;
}

interface ConceptMapping {
  statement: Statement;
  output: string;
  tags: string[];
  unit: UnitKind;
  taxonomy?: 'us-gaap' | 'dei';
}

const CONCEPTS: ConceptMapping[] = [
  { statement: 'income', output: 'totalRevenue', unit: 'USD', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'] },
  { statement: 'income', output: 'grossProfit', unit: 'USD', tags: ['GrossProfit'] },
  { statement: 'income', output: 'operatingIncome', unit: 'USD', tags: ['OperatingIncomeLoss'] },
  { statement: 'income', output: 'netIncome', unit: 'USD', tags: ['NetIncomeLoss', 'ProfitLoss'] },
  { statement: 'income', output: 'incomeBeforeTax', unit: 'USD', tags: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'] },
  { statement: 'income', output: 'incomeTaxExpense', unit: 'USD', tags: ['IncomeTaxExpenseBenefit'] },
  { statement: 'income', output: 'interestExpense', unit: 'USD', tags: ['InterestExpenseNonOperating', 'InterestExpense'] },
  { statement: 'income', output: 'dilutedEPS', unit: 'USD/shares', tags: ['EarningsPerShareDiluted'] },
  { statement: 'income', output: 'dilutedAverageShares', unit: 'shares', tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'] },
  { statement: 'balance', output: 'cashAndCashEquivalentsAtCarryingValue', unit: 'USD', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  { statement: 'balance', output: 'totalDebt', unit: 'USD', tags: ['LongTermDebtAndFinanceLeaseObligationsCurrentAndNoncurrent', 'LongTermDebtCurrentAndNoncurrent'] },
  { statement: 'balance', output: 'currentDebt', unit: 'USD', tags: ['LongTermDebtCurrent', 'ShortTermBorrowings'] },
  { statement: 'balance', output: 'longTermDebtNoncurrent', unit: 'USD', tags: ['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent'] },
  { statement: 'balance', output: 'totalAssets', unit: 'USD', tags: ['Assets'] },
  { statement: 'balance', output: 'totalLiabilities', unit: 'USD', tags: ['Liabilities'] },
  { statement: 'balance', output: 'totalShareholderEquity', unit: 'USD', tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { statement: 'balance', output: 'commonStockSharesOutstanding', unit: 'shares', tags: ['CommonStockSharesOutstanding'] },
  { statement: 'balance', output: 'commonStockSharesOutstanding', unit: 'shares', tags: ['EntityCommonStockSharesOutstanding'], taxonomy: 'dei' },
  { statement: 'cash', output: 'operatingCashflow', unit: 'USD', tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  { statement: 'cash', output: 'capitalExpenditures', unit: 'USD', tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsForAdditionsToPropertyPlantAndEquipment'] },
  { statement: 'cash', output: 'depreciationDepletionAndAmortization', unit: 'USD', tags: ['DepreciationDepletionAndAmortization', 'DepreciationDepletionAndAmortizationPropertyPlantAndEquipment'] },
  { statement: 'cash', output: 'dividendPayoutCommonStock', unit: 'USD', tags: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'] },
  { statement: 'cash', output: 'changeInWorkingCapital', unit: 'USD', tags: ['IncreaseDecreaseInOperatingCapital'] },
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function factsFor(
  payload: unknown,
  tag: string,
  unit: UnitKind,
  frequency: Frequency,
  taxonomy: 'us-gaap' | 'dei' = 'us-gaap',
): Fact[] {
  const root = record(payload);
  const facts = record(root?.facts);
  const taxonomyFacts = record(facts?.[taxonomy]);
  const concept = record(taxonomyFacts?.[tag]);
  const units = record(concept?.units);
  const rows = Array.isArray(units?.[unit]) ? units[unit] : [];
  return rows.flatMap((raw): Fact[] => {
    const row = record(raw);
    if (!row) return [];
    const val = typeof row.val === 'number' && Number.isFinite(row.val) ? row.val : null;
    const end = typeof row.end === 'string' ? row.end : null;
    const filed = typeof row.filed === 'string' ? row.filed : null;
    const form = typeof row.form === 'string' ? row.form : null;
    if (val === null || !end || !filed || !form) return [];
    const annual = frequency === 'annual';
    if (annual ? !/^10-K(?:\/A)?$/.test(form) : !/^10-Q(?:\/A)?$/.test(form)) return [];
    const start = typeof row.start === 'string' ? row.start : undefined;
    if (start) {
      const duration = (Date.parse(end) - Date.parse(start)) / 86_400_000;
      if (!Number.isFinite(duration)) return [];
      if (annual && (duration < 300 || duration > 430)) return [];
      if (!annual && (duration < 60 || duration > 120)) return [];
    } else if (frequency === 'quarterly' && unit !== 'shares' && tag !== 'Assets'
      && tag !== 'Liabilities' && !tag.includes('Cash') && !tag.includes('Debt')
      && !tag.includes('Equity')) {
      return [];
    }
    return [{
      val,
      start,
      end,
      filed,
      form,
      fy: typeof row.fy === 'number' ? row.fy : undefined,
      fp: typeof row.fp === 'string' ? row.fp : undefined,
      accn: typeof row.accn === 'string' ? row.accn : undefined,
    }];
  });
}

function reportsFor(
  payload: unknown,
  statement: Statement,
  frequency: Frequency,
): RawReport[] {
  const reports = new Map<string, RawReport>();
  for (const mapping of CONCEPTS.filter((item) => item.statement === statement)) {
    let selected: Fact[] = [];
    for (const tag of mapping.tags) {
      selected = factsFor(payload, tag, mapping.unit, frequency, mapping.taxonomy);
      if (selected.length) break;
    }
    const latestByEnd = new Map<string, Fact>();
    for (const fact of selected) {
      const existing = latestByEnd.get(fact.end);
      if (!existing || `${fact.filed}:${fact.accn ?? ''}` > `${existing.filed}:${existing.accn ?? ''}`) {
        latestByEnd.set(fact.end, fact);
      }
    }
    for (const fact of latestByEnd.values()) {
      const report = reports.get(fact.end) ?? {
        fiscalDateEnding: fact.end,
        reportedCurrency: 'USD',
        fiscalYear: fact.fy ?? Number(fact.end.slice(0, 4)),
        fiscalPeriod: frequency === 'annual' ? 'FY' : fact.fp ?? 'quarter',
        filingDate: fact.filed,
      };
      if (report[mapping.output] === undefined) report[mapping.output] = fact.val;
      reports.set(fact.end, report);
    }
  }
  return [...reports.values()].toSorted((left, right) =>
    String(left.fiscalDateEnding).localeCompare(String(right.fiscalDateEnding)));
}

function statementPayload(
  payload: unknown,
  statement: Statement,
): RawStatementPayload {
  return {
    annualReports: reportsFor(payload, statement, 'annual'),
    quarterlyReports: reportsFor(payload, statement, 'quarterly'),
  };
}

export class SecCompanyFactsFundamentalsProvider implements FundamentalsProvider {
  readonly id = 'sec-companyfacts';
  private tickerCache: { expiresAt: number; values: Map<string, string> } | null = null;
  private readonly snapshots = new Map<string, { expiresAt: number; value: FundamentalsSnapshot }>();
  private readonly inflight = new Map<string, Promise<FundamentalsSnapshot>>();

  constructor(
    private readonly userAgent: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getFinancialPeriods(rawSymbol: string): Promise<FundamentalsSnapshot> {
    const symbol = rawSymbol.trim().toUpperCase();
    const cached = this.snapshots.get(symbol);
    if (cached && cached.expiresAt > this.now()) {
      return { ...cached.value, dataState: 'provider-cached' };
    }
    const existing = this.inflight.get(symbol);
    if (existing) return existing;
    const operation = this.load(symbol).finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, operation);
    return operation;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Encoding': 'gzip, deflate',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MarketDataError(
          response.status === 429 ? 'rate-limited'
            : response.status === 404 ? 'invalid-symbol'
              : response.status >= 500 ? 'upstream-unavailable' : 'provider-unavailable',
          `SEC Company Facts request failed (${response.status})`,
        );
      }
      return await response.json();
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw new MarketDataError('timeout', 'SEC Company Facts request timed out');
      }
      throw new MarketDataError('upstream-unavailable', 'SEC Company Facts request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cikFor(symbol: string): Promise<string> {
    if (!this.tickerCache || this.tickerCache.expiresAt <= this.now()) {
      const payload = record(await this.getJson(TICKERS_URL));
      const values = new Map<string, string>();
      for (const value of Object.values(payload ?? {})) {
        const row = record(value);
        const ticker = typeof row?.ticker === 'string' ? row.ticker.toUpperCase() : null;
        const cik = typeof row?.cik_str === 'number' ? row.cik_str : Number.NaN;
        if (ticker && Number.isInteger(cik) && cik > 0) {
          values.set(ticker, String(cik).padStart(10, '0'));
        }
      }
      this.tickerCache = { values, expiresAt: this.now() + CACHE_MS };
    }
    const cik = this.tickerCache.values.get(symbol);
    if (!cik) throw new MarketDataError('invalid-symbol', `SEC CIK was not found for ${symbol}`);
    return cik;
  }

  private async load(symbol: string): Promise<FundamentalsSnapshot> {
    const started = this.now();
    const cik = await this.cikFor(symbol);
    const payload = await this.getJson(`${COMPANY_FACTS_URL}/CIK${cik}.json`);
    const fetchedAt = new Date(this.now()).toISOString();
    const normalized = normalizeFinancialStatements(
      symbol,
      statementPayload(payload, 'income'),
      statementPayload(payload, 'balance'),
      statementPayload(payload, 'cash'),
      { source: this.id, fetchedAt },
    );
    const asOf = [...normalized.annual, ...normalized.quarterly]
      .map((period) => period.periodEnd)
      .toSorted()
      .at(-1) ?? fetchedAt.slice(0, 10);
    const available = normalized.annual.length > 0;
    const snapshot: FundamentalsSnapshot = {
      symbol,
      periods: normalized.annual,
      quarterlyPeriods: normalized.quarterly,
      annualRecords: normalized.annualRecords,
      quarterlyRecords: normalized.quarterlyRecords,
      asOf,
      fetchedAt,
      currency: normalized.currency,
      dilutedEpsTtm: normalized.dilutedEpsTtm,
      dilutedEpsAsOf: normalized.dilutedEpsAsOf,
      missingInputs: normalized.missingInputs,
      datasetErrors: available ? {} : {
        'income-statement': 'invalid-provider-response',
        'balance-sheet': 'invalid-provider-response',
        'cash-flow': 'invalid-provider-response',
      },
      diagnostics: {
        provider: this.id,
        capabilities: ['SEC Company Facts', 'US-GAAP XBRL', '10-K', '10-Q'],
        datasets: {
          'income-statement': available ? 'available' : 'unavailable',
          'balance-sheet': available ? 'available' : 'unavailable',
          'cash-flow': available ? 'available' : 'unavailable',
        },
        cache: {
          'income-statement': 'miss',
          'balance-sheet': 'miss',
          'cash-flow': 'miss',
        },
        datasetFetchedAt: {
          'income-statement': fetchedAt,
          'balance-sheet': fetchedAt,
          'cash-flow': fetchedAt,
        },
        latencyMs: this.now() - started,
        normalizedPeriodCount: {
          annual: normalized.annual.length,
          quarterly: normalized.quarterly.length,
        },
      },
      providerUsed: this.id,
      dataState: 'authoritative-filing',
    };
    if (available) this.snapshots.set(symbol, { value: snapshot, expiresAt: this.now() + CACHE_MS });
    return snapshot;
  }
}
