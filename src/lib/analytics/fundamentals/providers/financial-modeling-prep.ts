import { MarketDataError, mapProviderFailure } from '../../../market-data/errors';
import { normalizeFinancialStatements, safeNumber, type DatasetName, type RawReport, type RawStatementPayload } from '../normalize';
import type { FundamentalsProvider, FundamentalsSnapshot } from '../provider';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const TTL_MS = 24 * 60 * 60 * 1_000;
const STALE_MS = 7 * TTL_MS;
const TIMEOUT_MS = 10_000;
const LIMIT = 20;
/** Real, absolute financial magnitudes never legitimately exceed this. Anything past it signals a provider unit/scale anomaly (e.g. values reported in a foreign unit). */
const MAX_ABSOLUTE_MAGNITUDE = 1e15;

const ENDPOINTS: Record<DatasetName, string> = {
  'income-statement': 'income-statement',
  'balance-sheet': 'balance-sheet-statement',
  'cash-flow': 'cash-flow-statement',
};
type Frequency = 'annual' | 'quarter';
type Fetcher = typeof fetch;
interface RawRow { [key: string]: unknown }
interface Cached { rows: RawRow[]; fetchedAt: number }

/** Map a Financial Modeling Prep statement row onto the Alpha-Vantage-shaped field
 * names the shared normalizer already understands. This is a pure rename — no
 * value is fabricated, rescaled, or derived — so both providers flow through the
 * single deterministic `normalizeFinancialStatements` mapping and `nexora-fv-v1`. */
function toRawReport(dataset: DatasetName, row: RawRow): RawReport {
  const common: RawReport = {
    fiscalDateEnding: row.date,
    reportedCurrency: row.reportedCurrency,
    fiscalYear: row.fiscalYear,
    fiscalPeriod: row.period,
    filingDate: row.filingDate,
  };
  if (dataset === 'income-statement') {
    return {
      ...common,
      totalRevenue: row.revenue,
      grossProfit: row.grossProfit,
      operatingIncome: row.operatingIncome,
      ebitda: row.ebitda,
      netIncome: row.netIncome,
      incomeBeforeTax: row.incomeBeforeTax,
      incomeTaxExpense: row.incomeTaxExpense,
      // FMP's diluted EPS/share fields are the true period-average diluted figures
      // (unlike Alpha Vantage, which only exposes point-in-time outstanding shares).
      dilutedEPS: row.epsDiluted ?? row.epsdiluted,
      weightedAverageShsOutDil: row.weightedAverageShsOutDil,
      interestExpense: row.interestExpense,
    };
  }
  if (dataset === 'balance-sheet') {
    return {
      ...common,
      totalAssets: row.totalAssets,
      totalLiabilities: row.totalLiabilities,
      totalShareholderEquity: row.totalStockholdersEquity,
      totalDebt: row.totalDebt,
      shortTermDebt: row.shortTermDebt,
      longTermDebt: row.longTermDebt,
      cashAndCashEquivalentsAtCarryingValue: row.cashAndCashEquivalents,
      cashAndShortTermInvestments: row.cashAndShortTermInvestments,
    };
  }
  return {
    ...common,
    operatingCashflow: row.operatingCashFlow,
    capitalExpenditures: row.capitalExpenditure,
    depreciationDepletionAndAmortization: row.depreciationAndAmortization,
    changeInWorkingCapital: row.changeInWorkingCapital,
    dividendPayoutCommonStock: row.commonDividendsPaid ?? row.netDividendsPaid ?? row.dividendsPaid,
  };
}

/** Reject rows whose absolute magnitudes are physically impossible, which would
 * otherwise indicate the provider silently switched units/scale. Invalid periods
 * are excluded (per the existing normalization policy) rather than corrected. */
function withinScale(row: RawReport): boolean {
  for (const value of Object.values(row)) {
    const numeric = safeNumber(value);
    if (numeric !== null && Math.abs(numeric) > MAX_ABSOLUTE_MAGNITUDE) return false;
  }
  return true;
}

export class FinancialModelingPrepFundamentalsProvider implements FundamentalsProvider {
  readonly id = 'financial-modeling-prep';
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<{ rows: RawRow[]; cache: 'hit' | 'miss' | 'stale'; fetchedAt: number }>>();

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private retryAfter(response: Response): number | undefined {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - this.now()) / 1_000)) : undefined;
  }

  private async network(symbol: string, dataset: DatasetName, frequency: Frequency, signal?: AbortSignal): Promise<RawRow[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = new URL(`${BASE_URL}/${ENDPOINTS[dataset]}`);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('period', frequency);
      url.searchParams.set('limit', String(LIMIT));
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetcher(url, { headers: { Accept: 'application/json', apikey: this.apiKey }, signal: combined, cache: 'no-store' });
      } catch (cause) {
        const error = mapProviderFailure({ cause });
        if (attempt < 2 && error.retryable) { await this.sleep(250 * (2 ** attempt)); continue; }
        throw error;
      }
      let payload: unknown;
      try { payload = await response.json(); } catch (cause) { throw mapProviderFailure({ status: response.status, cause }); }
      const retryAfter = this.retryAfter(response);
      if (!response.ok) {
        const error = mapProviderFailure({ status: response.status, payload, retryAfterSeconds: retryAfter });
        if (attempt < 2 && error.retryable) { await this.sleep((retryAfter ?? (attempt + 1)) * 1_000); continue; }
        throw error;
      }
      // FMP signals throttling/plan errors as a JSON object with an "Error Message".
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const error = mapProviderFailure({ status: response.status, payload, retryAfterSeconds: retryAfter });
        if (attempt < 2 && error.retryable) { await this.sleep((retryAfter ?? (attempt + 1)) * 1_000); continue; }
        throw error;
      }
      if (!Array.isArray(payload)) throw new MarketDataError('invalid-provider-response', 'FMP fundamentals returned a non-array statement payload');
      return payload.filter((row): row is RawRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
    }
    throw new MarketDataError('upstream-unavailable', 'FMP fundamentals retry budget exhausted');
  }

  private load(symbol: string, dataset: DatasetName, frequency: Frequency, signal?: AbortSignal) {
    const key = `${this.id}:${symbol}:${dataset}:${frequency}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const cached = this.cache.get(key);
      const age = cached ? this.now() - cached.fetchedAt : Infinity;
      if (cached && age <= TTL_MS) return { rows: cached.rows, cache: 'hit' as const, fetchedAt: cached.fetchedAt };
      try {
        const rows = await this.network(symbol, dataset, frequency, signal);
        const fetchedAt = this.now();
        this.cache.set(key, { rows, fetchedAt });
        return { rows, cache: 'miss' as const, fetchedAt };
      } catch (error) {
        if (cached && age <= STALE_MS) return { rows: cached.rows, cache: 'stale' as const, fetchedAt: cached.fetchedAt };
        throw error;
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, operation);
    return operation;
  }

  async getFinancialPeriods(rawSymbol: string, signal?: AbortSignal): Promise<FundamentalsSnapshot> {
    const symbol = rawSymbol.trim().toUpperCase();
    const started = this.now();
    const datasets = Object.keys(ENDPOINTS) as DatasetName[];
    const settled = await Promise.all(datasets.map(async (dataset) => {
      try {
        const [annual, quarter] = await Promise.all([
          this.load(symbol, dataset, 'annual', signal),
          this.load(symbol, dataset, 'quarter', signal),
        ]);
        return { dataset, annual, quarter, error: null as string | null };
      } catch (cause) {
        return { dataset, annual: null, quarter: null, error: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'upstream-unavailable' };
      }
    }));

    const payloads = new Map<DatasetName, RawStatementPayload>();
    const cacheState: Record<string, 'hit' | 'miss' | 'stale'> = {};
    const datasetFetchedAt: Record<string, string | null> = {};
    const datasetErrors: Record<string, string> = {};
    let latestFetchedAt = 0;
    for (const item of settled) {
      if (item.annual && item.quarter) {
        const annualReports = item.annual.rows.map((row) => toRawReport(item.dataset, row)).filter(withinScale);
        const quarterlyReports = item.quarter.rows.map((row) => toRawReport(item.dataset, row)).filter(withinScale);
        payloads.set(item.dataset, { symbol, annualReports, quarterlyReports });
        const fetchedAt = Math.max(item.annual.fetchedAt, item.quarter.fetchedAt);
        latestFetchedAt = Math.max(latestFetchedAt, fetchedAt);
        cacheState[item.dataset] = item.annual.cache === 'stale' || item.quarter.cache === 'stale' ? 'stale' : item.annual.cache === 'hit' && item.quarter.cache === 'hit' ? 'hit' : 'miss';
        datasetFetchedAt[item.dataset] = new Date(fetchedAt).toISOString();
      } else {
        cacheState[item.dataset] = 'miss';
        datasetFetchedAt[item.dataset] = null;
        if (item.error) datasetErrors[item.dataset] = item.error;
      }
    }

    const missingDatasets = datasets.filter((dataset) => !payloads.has(dataset));
    const empty: RawStatementPayload = { symbol, annualReports: [], quarterlyReports: [] };
    const fetchedAt = new Date(latestFetchedAt || this.now()).toISOString();
    const normalized = normalizeFinancialStatements(
      symbol,
      payloads.get('income-statement') ?? empty,
      payloads.get('balance-sheet') ?? empty,
      payloads.get('cash-flow') ?? empty,
      { source: this.id, fetchedAt },
    );

    const diagnostics = {
      provider: this.id,
      capabilities: ['income-statement', 'balance-sheet', 'cash-flow', 'diluted-eps', 'diluted-shares'],
      datasets: Object.fromEntries(datasets.map((dataset) => [dataset, payloads.has(dataset) ? 'available' : 'unavailable'])) as Record<string, 'available' | 'unavailable'>,
      cache: Object.fromEntries(datasets.map((dataset) => [dataset, cacheState[dataset] ?? 'miss'])) as Record<string, 'hit' | 'miss' | 'stale'>,
      datasetFetchedAt,
      latencyMs: Math.max(0, this.now() - started),
      normalizedPeriodCount: { annual: normalized.annual.length, quarterly: normalized.quarterly.length },
    };

    return {
      symbol,
      periods: normalized.annual,
      quarterlyPeriods: normalized.quarterly,
      annualRecords: normalized.annualRecords,
      quarterlyRecords: normalized.quarterlyRecords,
      asOf: normalized.annual.at(-1)?.periodEnd ?? normalized.quarterly.at(-1)?.periodEnd ?? normalized.dilutedEpsAsOf ?? fetchedAt,
      fetchedAt,
      currency: normalized.currency,
      dilutedEpsTtm: normalized.dilutedEpsTtm,
      dilutedEpsAsOf: normalized.dilutedEpsAsOf,
      missingInputs: [...missingDatasets.map((dataset) => `dataset:${dataset}`), ...normalized.missingInputs],
      datasetErrors,
      diagnostics,
      primaryProvider: this.id,
      providerUsed: this.id,
      fallbackUsed: false,
      fallbackReason: null,
    };
  }
}
