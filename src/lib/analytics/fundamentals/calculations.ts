import type { DataFreshness } from '@/src/lib/market-data/types';
import type { KeyStatisticsInput, KeyStatisticsResult, MetricMetadata, MetricResult } from './types';

function finite(value: number | null | undefined): value is number { return typeof value === 'number' && Number.isFinite(value); }

function statusFromFreshness(freshness: DataFreshness): 'available' | 'delayed' | 'stale' {
  if (freshness.status === 'stale') return 'stale';
  if (freshness.status === 'delayed' || freshness.status === 'end-of-day' || freshness.status === 'cached') return 'delayed';
  return 'available';
}

function metadata(input: KeyStatisticsInput, period: string, methodology: string, inputs: MetricMetadata['inputs'], sourceType: MetricMetadata['sourceType']): MetricMetadata {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  return { symbol: input.symbol, currency: input.currency, source: input.provider, sourceType, period, asOf: input.priceAsOf, latestDataAt: input.priceAsOf, calculatedAt, freshness: input.freshness, methodology, inputs, assumptions: [], limitations: [] };
}

function unavailable(input: KeyStatisticsInput, name: string, missingInputs: string[], source = input.provider): MetricResult {
  return { ...metadata(input, 'latest available', `${name} is reported only when verified inputs are available`, {}, 'provider-supplied'), source, status: 'unavailable', reason: `ไม่สามารถแสดง ${name} ได้: ขาดข้อมูลจริง ${missingInputs.join(', ')}`, missingInputs };
}

export function trailingPe(price: number | null, dilutedEpsTtm: number | null, priceCurrency: string | null, epsCurrency: string | null): { status: 'available'; value: number } | { status: 'unavailable' | 'not-meaningful'; reason: string } {
  if (!finite(price) || price < 0 || !finite(dilutedEpsTtm)) return { status: 'unavailable', reason: 'ขาดราคาตลาดหรือ diluted EPS TTM ที่ตรวจสอบได้' };
  if (!priceCurrency || !epsCurrency || priceCurrency !== epsCurrency) return { status: 'unavailable', reason: 'สกุลเงินของราคาและ EPS ไม่ตรงกันและไม่มีอัตราแปลงที่ตรวจสอบได้' };
  if (dilutedEpsTtm <= 0) return { status: 'not-meaningful', reason: 'P/E ไม่มีความหมายเมื่อ diluted EPS TTM น้อยกว่าหรือเท่ากับศูนย์' };
  const value = price / dilutedEpsTtm;
  return Number.isFinite(value) ? { status: 'available', value } : { status: 'unavailable', reason: 'P/E result is not a finite number' };
}

export function averageVolume(volumes: readonly (number | null)[], period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || volumes.length < period) return null;
  const window = volumes.slice(-period);
  const complete = window.filter(finite);
  if (complete.length !== period || complete.some((value) => value < 0)) return null;
  return complete.reduce((sum, value) => sum + value, 0) / period;
}

export function relativeDailyVolume(currentVolume: number | null, average: number | null): number | null {
  return finite(currentVolume) && currentVolume >= 0 && finite(average) && average > 0 ? currentVolume / average : null;
}

export function calculateKeyStatistics(input: KeyStatisticsInput): KeyStatisticsResult {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const volumes = input.history.map((row) => row.volume);
  const result: Record<string, MetricResult> = {};
  const addNumber = (key: string, value: number | null | undefined, unit: string, period: string, methodology: string, sourceType: MetricMetadata['sourceType'] = 'provider-supplied', limitations: string[] = []) => {
    result[key] = finite(value)
      ? { ...metadata({ ...input, calculatedAt }, period, methodology, { value }, sourceType), status: statusFromFreshness(input.freshness), value, unit, limitations }
      : unavailable(input, key, [key]);
  };

  const pe = trailingPe(input.price, input.dilutedEpsTtm ?? null, input.currency, input.dilutedEpsCurrency ?? input.currency);
  result.trailingPe = pe.status === 'available' && input.freshness.status === 'stale'
    ? { ...metadata({ ...input, calculatedAt }, 'TTM', 'Current market price / diluted EPS TTM', { marketPrice: input.price, dilutedEpsTtm: input.dilutedEpsTtm ?? null }, 'calculated'), source: `${input.provider}; ${input.fundamentalsProvider ?? 'fundamentals unavailable'}`, latestDataAt: input.fundamentalsAsOf ?? input.priceAsOf, status: 'unavailable', reason: 'Market price is older than the allowed P/E freshness policy.', missingInputs: ['nonStaleMarketPrice'] }
    : pe.status === 'available'
    ? { ...metadata({ ...input, calculatedAt }, 'TTM', 'Current market price / diluted EPS TTM', { marketPrice: input.price, dilutedEpsTtm: input.dilutedEpsTtm ?? null }, 'calculated'), source: `${input.provider}; ${input.fundamentalsProvider ?? 'fundamentals unavailable'}`, latestDataAt: input.fundamentalsAsOf ?? input.priceAsOf, status: statusFromFreshness(input.freshness), value: pe.value, unit: 'x' }
    : { ...metadata({ ...input, calculatedAt }, 'TTM', 'Current market price / diluted EPS TTM', { marketPrice: input.price, dilutedEpsTtm: input.dilutedEpsTtm ?? null }, 'calculated'), source: `${input.provider}; ${input.fundamentalsProvider ?? 'fundamentals unavailable'}`, latestDataAt: input.fundamentalsAsOf ?? input.priceAsOf, status: pe.status, reason: pe.reason, missingInputs: pe.status === 'unavailable' ? (input.fundamentalsMissingInputs?.length ? input.fundamentalsMissingInputs : ['dilutedEpsTtm']) : [] };

  const forward = trailingPe(input.price, input.forwardConsensusEps ?? null, input.currency, input.currency);
  result.forwardPe = input.forwardConsensusEps == null ? unavailable(input, 'Forward P/E', ['verified consensus forward EPS']) : forward.status === 'available'
    ? { ...metadata({ ...input, calculatedAt }, 'forward consensus period', 'Current market price / verified consensus forward EPS', { marketPrice: input.price, consensusEps: input.forwardConsensusEps }, 'calculated'), status: statusFromFreshness(input.freshness), value: forward.value, unit: 'x' }
    : { ...metadata({ ...input, calculatedAt }, 'forward consensus period', 'Current market price / verified consensus forward EPS', { marketPrice: input.price, consensusEps: input.forwardConsensusEps }, 'calculated'), status: forward.status, reason: forward.reason, missingInputs: [] };

  addNumber('currentVolume', input.currentVolume, 'shares', 'current/latest session', 'Provider-reported cumulative session volume');
  for (const period of [20, 30, 50]) {
    const average = averageVolume(volumes, period);
    addNumber(`averageVolume${period}`, average, 'shares/day', `${period} trading days`, `Arithmetic mean of the latest ${period} complete daily OHLCV volumes`, 'calculated');
  }
  const avg20 = averageVolume(volumes, 20);
  const relative = relativeDailyVolume(input.currentVolume, avg20);
  addNumber('relativeVolume', relative, 'x', 'current session vs 20 trading days', 'Current cumulative daily volume / average complete daily volume (20 days)', 'calculated', ['ใช้ daily volume จึงยังเทียบเวลาเดียวกันระหว่าง session ไม่ได้', 'หากตลาดยังเปิดอยู่ session ปัจจุบันอาจยังไม่จบ']);
  addNumber('marketCap', input.marketCap, input.currency ?? 'currency unavailable', 'latest available', 'Provider-supplied market capitalization');
  addNumber('dilutedEpsTtm', input.dilutedEpsTtm, `${input.currency ?? 'currency unavailable'}/share`, 'TTM', 'Provider-supplied diluted EPS after fiscal-period normalization');
  addNumber('sharesOutstanding', input.sharesOutstanding, 'shares', 'latest fiscal/market period', 'Provider-supplied split-adjusted shares outstanding');
  addNumber('dilutedShares', input.dilutedShares, 'shares', 'TTM', 'Provider-supplied weighted-average diluted shares');
  ['putCallVolume','putCallOpenInterest','revenue','freeCashFlow','dividendYield','beta','fiftyTwoWeekHigh','fiftyTwoWeekLow','earningsDate'].forEach((key) => { result[key] = unavailable(input, key, [`verified ${key} provider data`]); });

  return { status: 'available', symbol: input.symbol, currency: input.currency, source: input.fundamentalsProvider ? `${input.provider}; ${input.fundamentalsProvider}` : input.provider, sourceType: 'calculated', period: 'latest/TTM as labelled per metric', asOf: input.priceAsOf, latestDataAt: input.fundamentalsAsOf ?? input.priceAsOf, calculatedAt, freshness: input.freshness, methodology: 'Deterministic key-statistics v1; unavailable inputs are never fabricated', inputs: { marketPrice: input.price, currentVolume: input.currentVolume, historicalDailyRows: input.history.length }, assumptions: [], limitations: ['Options metrics remain unavailable until separately verified provider capabilities are integrated.'], metrics: result };
}
