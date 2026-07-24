import 'server-only';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { getFundamentalsProvider } from '../fundamentals/provider';
import { calculateFairValue } from './engine';
import {
  safeFairValueErrorCode,
  writeFairValueLog,
  type FairValueLogger,
} from './logging';
import { getFmpValuationProvider } from './providers/financial-modeling-prep';
import { createFairValueUnavailable } from './result';
import type {
  FairValueFailureKind,
  FairValueResult,
  FairValueUnavailable,
  ValuationInput,
} from './types';

function unavailable(
  failureKind: FairValueFailureKind,
  symbol: string,
  calculatedAt: string,
  reason: string,
  missingFields: string[],
  currency: string | null = null,
  provider: string | null = null,
  asOf: string = calculatedAt,
): FairValueUnavailable {
  return createFairValueUnavailable({
    failureKind,
    symbol,
    currency,
    provider,
    reason,
    missingFields,
    asOf,
    calculatedAt,
    limitations: [
      'No financial value, estimate, peer, market input, FX rate, or fair value is fabricated.',
    ],
  });
}

function logUnavailable(
  result: FairValueUnavailable,
  provider?: string,
  errorCode?: string,
  logger: FairValueLogger = writeFairValueLog,
): FairValueUnavailable {
  logger({
    event: 'fair_value_evaluation',
    status: 'unavailable',
    symbol: result.symbol,
    provider: provider ?? result.provider ?? undefined,
    failureKind: result.failureKind,
    missingInputCount: result.missingInputs.length,
    errorCode,
  });
  return result;
}

export function calculateFairValueSafely(
  input: ValuationInput,
  calculate: typeof calculateFairValue = calculateFairValue,
  logger: FairValueLogger = writeFairValueLog,
): FairValueResult {
  try {
    const result = calculate(input);
    if (result.status === 'unavailable') {
      return logUnavailable(result, input.source, undefined, logger);
    }
    logger({
      event: 'fair_value_evaluation',
      status: 'available',
      symbol: result.symbol,
      provider: input.source,
      missingInputCount: result.missingInputs.length,
    });
    return result;
  } catch (cause) {
    const errorCode = safeFairValueErrorCode(cause);
    return logUnavailable(
      unavailable(
        'calculation-error',
        input.symbol,
        input.calculatedAt ?? new Date().toISOString(),
        'เซิร์ฟเวอร์ตรวจสอบผล Fair Value ไม่สำเร็จ จึงไม่เผยแพร่ค่าประเมิน',
        ['valuationCalculation'],
        input.currency || null,
        input.source || null,
        input.priceAsOf || input.calculatedAt || new Date().toISOString(),
      ),
      input.source,
      errorCode,
      logger,
    );
  }
}

function failureKind(code: string): FairValueFailureKind {
  if (code === 'rate-limited') return 'provider-rate-limited';
  if (['RangeError', 'Error', 'internal-error', 'unknown-error'].includes(code)) {
    return 'calculation-error';
  }
  return 'provider-unavailable';
}

function providerFailureReason(code: string, missingField: string): string {
  if (code === 'rate-limited') {
    return 'ผู้ให้บริการจำกัดคำขอชั่วคราว จึงยังคำนวณ Fair Value ไม่ได้';
  }
  if (missingField === 'forwardEstimates') {
    return 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates';
  }
  return 'ผู้ให้บริการส่งข้อมูลที่จำเป็นต่อ Fair Value ไม่สำเร็จ';
}

export async function loadFairValue(symbol: string): Promise<FairValueResult> {
  const calculatedAt = new Date().toISOString();
  const fundamentals = getFundamentalsProvider();
  const valuationProvider = getFmpValuationProvider();
  if (!fundamentals) {
    return logUnavailable(unavailable(
      'provider-unavailable',
      symbol,
      calculatedAt,
      'ยังคำนวณ Fair Value ไม่ได้ เพราะไม่ได้ตั้งค่า provider งบการเงินจริง',
      ['financialStatements'],
    ));
  }
  if (!valuationProvider) {
    return logUnavailable(unavailable(
      'provider-unavailable',
      symbol,
      calculatedAt,
      'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates จาก FMP',
      ['forwardEstimates', 'stockPeers', 'waccMarketInputs'],
      null,
      'financial-modeling-prep',
    ));
  }

  let market: ReturnType<typeof getMarketDataProvider> | null = null;
  let marketProviderCause: unknown = new Error('Market provider is unavailable');
  try {
    market = getMarketDataProvider();
  } catch (cause) {
    marketProviderCause = cause;
  }

  const [quoteResult, profileResult, financialsResult, valuationResult] =
    await Promise.allSettled([
      market ? market.getQuote(symbol) : Promise.reject(marketProviderCause),
      market ? market.getCompanyProfile(symbol) : Promise.reject(marketProviderCause),
      fundamentals.getFinancialPeriods(symbol),
      valuationProvider.getValuationDataset(symbol),
    ]);
  const required = [
    { field: 'financialStatements', provider: fundamentals.id, result: financialsResult },
    { field: 'forwardEstimates', provider: valuationProvider.id, result: valuationResult },
  ];
  const failed = required.find((item) => item.result.status === 'rejected');
  if (failed?.result.status === 'rejected') {
    const code = safeFairValueErrorCode(failed.result.reason);
    return logUnavailable(
      unavailable(
        failureKind(code),
        symbol,
        calculatedAt,
        providerFailureReason(code, failed.field),
        [failed.field],
        null,
        failed.provider,
      ),
      failed.provider,
      code,
    );
  }
  if (
    financialsResult.status !== 'fulfilled'
    || valuationResult.status !== 'fulfilled'
  ) {
    return logUnavailable(unavailable(
      'calculation-error',
      symbol,
      calculatedAt,
      'เซิร์ฟเวอร์ไม่สามารถยืนยันผลจาก provider ได้อย่างปลอดภัย',
      ['providerResult'],
    ));
  }

  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const financials = financialsResult.value;
  const valuation = valuationResult.value;
  const marketPrice = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.data.price
    : valuation.marketPrice;
  const marketPriceSource = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.provider ?? market?.id ?? 'market-provider'
    : valuation.provider;
  const marketPriceAsOf = quote && Number.isFinite(quote.data.price) && quote.data.price > 0
    ? quote.freshness.asOf ?? calculatedAt
    : valuation.marketPriceAsOf ?? calculatedAt;
  if (!Number.isFinite(marketPrice) || marketPrice === null || marketPrice <= 0) {
    const marketFailure = quoteResult.status === 'rejected'
      ? safeFairValueErrorCode(quoteResult.reason)
      : 'missing-field';
    return logUnavailable(
      unavailable(
        failureKind(marketFailure),
        symbol,
        calculatedAt,
        providerFailureReason(marketFailure, 'marketPrice'),
        ['marketPrice'],
        profile?.data.currency ?? valuation.currency,
        market?.id ?? valuation.provider,
        marketPriceAsOf,
      ),
      market?.id ?? valuation.provider,
      marketFailure,
    );
  }
  if (!financials.periods.length) {
    const errorCodes = Object.values(financials.datasetErrors ?? {});
    const rateLimited = errorCodes.includes('rate-limited');
    return logUnavailable(
      unavailable(
        rateLimited ? 'provider-rate-limited' : 'missing-field',
        symbol,
        calculatedAt,
        rateLimited
          ? 'ผู้ให้บริการงบการเงินจำกัดคำขอชั่วคราว จึงยังคำนวณ Fair Value ไม่ได้'
          : 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาดงบการเงินจริง',
        [...financials.missingInputs, 'financialStatements'],
        financials.currency || null,
        financials.providerUsed ?? fundamentals.id,
        financials.asOf || calculatedAt,
      ),
      financials.providerUsed ?? fundamentals.id,
      rateLimited ? 'rate-limited' : undefined,
    );
  }

  const financialCurrency = financials.currency.toUpperCase();
  const quoteCurrency = (
    profile?.data.currency
    ?? quote?.data.currency
    ?? valuation.currency
    ?? ''
  ).toUpperCase();
  if (financialCurrency !== 'USD' || quoteCurrency !== 'USD') {
    return logUnavailable(unavailable(
      'currency-mismatch',
      symbol,
      calculatedAt,
      'Fair Value v2 คำนวณจากข้อมูล USD เท่านั้น และไม่แปลงสกุลเงินระหว่างคำนวณ',
      ['valuationInputsNormalizedToUSD'],
      financialCurrency || quoteCurrency || null,
      financials.providerUsed ?? fundamentals.id,
      financials.asOf,
    ));
  }

  const providerUsed = financials.providerUsed ?? fundamentals.id;
  const providerStatus = valuation.cacheStatus === 'stale'
    || Object.values(financials.diagnostics.cache).includes('stale')
    ? 'stale' as const
    : valuation.cacheStatus === 'hit'
      && Object.values(financials.diagnostics.cache).every((state) => state === 'hit')
      ? 'cached' as const
      : quote?.freshness.status === 'delayed' || quote?.freshness.status === 'end-of-day'
        ? 'delayed' as const : 'live' as const;
  const marketCapitalization =
    profile?.data.marketCapitalization ?? valuation.marketCapitalization;
  const latestFinancialPeriod = [...financials.periods]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(-1);

  return calculateFairValueSafely({
    symbol,
    currency: 'USD',
    marketPrice,
    marketPriceSource,
    marketCapitalization,
    sharesOutstanding: valuation.sharesOutstanding,
    sharesOutstandingAsOf: valuation.sharesOutstandingAsOf,
    dilutedSharesSource: latestFinancialPeriod
      && Number.isFinite(latestFinancialPeriod.dilutedShares)
      && latestFinancialPeriod.dilutedShares > 0
      ? 'diluted'
      : 'shares-outstanding-fallback',
    priceAsOf: marketPriceAsOf,
    source: providerUsed,
    sourceType: 'provider-supplied',
    sector: profile?.data.sector ?? valuation.sector ?? '',
    industry: profile?.data.industry ?? valuation.industry ?? '',
    periods: financials.periods,
    historicalPrices: [],
    historySource: '',
    historyFreshness: {
      status: 'unavailable',
      asOf: null,
      maxAgeSeconds: null,
    },
    analystEstimates: valuation.estimates,
    peerObservations: valuation.peers,
    waccMarketInputs: valuation.waccMarketInputs,
    providerStatus,
    displayFx: null,
    calculatedAt,
  });
}
