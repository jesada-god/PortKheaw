import { MarketDataError } from '@/src/lib/market-data/errors';
import type { NormalizedCandleResult } from '@/src/lib/market-data/candles';
import type { ProviderResult, Quote } from '@/src/lib/market-data/types';
import {
  continuousComparisonClose,
  freshnessFromMode,
  historyFallbackModeFromStatus,
  resolveAcceptedPrice,
  type AcceptedPriceCandidate,
} from '@/src/lib/stock-detail/market-source';
import { overviewPriceStatus } from './presentation';
import type { InstrumentMetadata, OverviewPrice } from './types';

export const CONTINUOUS_MARKET_SESSION_LABEL = 'ซื้อขายตลอด 24 ชม.';

export type ContinuousMarketInput = {
  instrument: InstrumentMetadata;
  quote: Promise<ProviderResult<Quote>>;
  candles: Promise<ProviderResult<NormalizedCandleResult>>;
};

function canonical(symbol: string) {
  return symbol.trim().toUpperCase();
}

function publicFailureReason(cause: unknown): string {
  if (!(cause instanceof MarketDataError)) return 'ผู้ให้บริการข้อมูลตลาดไม่พร้อมใช้งานชั่วคราว';
  switch (cause.code) {
    case 'rate-limited': return 'ผู้ให้บริการจำกัดจำนวนคำขอชั่วคราว';
    case 'timeout': return 'ผู้ให้บริการตอบกลับช้ากว่าเวลาที่กำหนด';
    case 'not-found':
    case 'insufficient-data': return 'ผู้ให้บริการยังไม่มีข้อมูลที่ใช้ได้สำหรับสินทรัพย์นี้';
    case 'forbidden':
    case 'provider-unauthorized': return 'สิทธิ์ของผู้ให้บริการไม่ครอบคลุมข้อมูลนี้';
    case 'invalid-symbol': return 'ผู้ให้บริการไม่รู้จักสัญลักษณ์สินทรัพย์นี้';
    default: return 'ผู้ให้บริการข้อมูลตลาดไม่พร้อมใช้งานชั่วคราว';
  }
}

function unavailable(
  instrument: InstrumentMetadata,
  failures: unknown[],
): OverviewPrice {
  const reasons = [...new Set(failures.map(publicFailureReason))];
  return {
    symbol: instrument.symbol,
    instrument,
    price: null,
    currency: instrument.currency,
    change: null,
    changePercent: null,
    session: 'CONTINUOUS',
    sessionLabel: CONTINUOUS_MARKET_SESSION_LABEL,
    status: 'unavailable',
    asOf: null,
    source: 'Yahoo Finance Chart',
    unavailableReason: reasons.join(' · '),
    tradingDate: null,
    extended: null,
    freshness: {
      status: 'unavailable',
      asOf: null,
      maxAgeSeconds: null,
    },
    sparkline: [],
  };
}

function usableCandles(
  instrument: InstrumentMetadata,
  result: ProviderResult<NormalizedCandleResult>,
) {
  if (canonical(result.data.symbol) !== canonical(instrument.symbol)) return [];
  return result.data.candles.filter((candle) =>
    Number.isFinite(candle.close) && candle.close > 0);
}

export interface ContinuousAcceptedMarketData {
  accepted: AcceptedPriceCandidate | null;
  quote: Quote | null;
  candles: ReturnType<typeof usableCandles>;
  comparisonBase: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  freshness: ProviderResult<Quote>['freshness'];
  provider: string | null;
  failures: unknown[];
}

function positive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function quoteCandidate(
  instrument: InstrumentMetadata,
  result: ProviderResult<Quote>,
): AcceptedPriceCandidate | null {
  if (canonical(result.data.symbol) !== canonical(instrument.symbol)) return null;
  if (!positive(result.data.price)) return null;
  return {
    price: result.data.price,
    source: 'snapshot',
    exchangeTimestamp: result.data.quoteTimestamp ?? result.freshness.asOf,
    mode: historyFallbackModeFromStatus(result.freshness.status),
    provider: result.provider ?? null,
    priceRole: 'regular',
  };
}

/** Shared timestamp-first accepted price for every continuous-market surface. */
export async function resolveContinuousAcceptedMarketData({
  instrument,
  quote,
  candles,
}: ContinuousMarketInput): Promise<ContinuousAcceptedMarketData> {
  const [quoteResult, candleResult] = await Promise.allSettled([quote, candles]);
  const validQuote = quoteResult.status === 'fulfilled'
    ? quoteCandidate(instrument, quoteResult.value)
    : null;
  const candleData = candleResult.status === 'fulfilled'
    ? usableCandles(instrument, candleResult.value)
    : [];
  const latestCandle = candleData.at(-1) ?? null;
  const candleAccepted: AcceptedPriceCandidate | null = latestCandle
    ? {
        price: latestCandle.close,
        source: 'aggregate-fallback',
        exchangeTimestamp: new Date(latestCandle.timestamp * 1_000).toISOString(),
        mode: historyFallbackModeFromStatus(candleResult.status === 'fulfilled'
          ? candleResult.value.data.dataStatus
          : 'unavailable'),
        provider: candleResult.status === 'fulfilled'
          ? candleResult.value.provider ?? candleResult.value.data.provider
          : null,
        priceRole: 'regular',
      }
    : null;
  const accepted = resolveAcceptedPrice([validQuote, candleAccepted]);
  const quoteData = validQuote && quoteResult.status === 'fulfilled'
    ? quoteResult.value.data
    : null;
  const firstCandle = candleData[0] ?? null;
  const comparisonBase = !accepted
    ? null
    : accepted.source === 'snapshot'
      ? quoteData?.previousRegularClose ?? quoteData?.previousClose ?? null
      : continuousComparisonClose(quoteData, accepted.exchangeTimestamp)
        ?? (firstCandle && firstCandle.timestamp < (latestCandle?.timestamp ?? 0)
          ? firstCandle.close
          : null);
  const change = accepted && positive(comparisonBase)
    ? accepted.price - comparisonBase
    : null;
  const changePercent = change !== null && positive(comparisonBase)
    ? change / comparisonBase * 100
    : null;
  const acceptedQuote = accepted?.source === 'snapshot' && quoteResult.status === 'fulfilled'
    ? quoteResult.value
    : null;
  const acceptedCandles = accepted?.source !== 'snapshot' && candleResult.status === 'fulfilled'
    ? candleResult.value
    : null;
  const failures: unknown[] = [
    quoteResult.status === 'rejected'
      ? quoteResult.reason
      : validQuote ? null : new MarketDataError('invalid-provider-response', 'Continuous quote symbol or price was invalid'),
    candleResult.status === 'rejected'
      ? candleResult.reason
      : latestCandle ? null : new MarketDataError('insufficient-data', 'Continuous candles were empty or invalid'),
  ].filter((failure) => failure !== null);

  return {
    accepted,
    quote: quoteData,
    candles: candleData,
    comparisonBase,
    change,
    changePercent,
    currency: acceptedQuote?.data.currency
      ?? acceptedCandles?.data.currency
      ?? instrument.currency,
    freshness: acceptedQuote?.freshness
      ?? (acceptedCandles && accepted
        ? freshnessFromMode(accepted.mode, accepted.exchangeTimestamp)
        : { status: 'unavailable', asOf: null, maxAgeSeconds: null }),
    provider: accepted?.provider ?? null,
    failures,
  };
}

/**
 * Loads a continuous market without touching the US-equity resolver or session
 * model. Quote and candle work settle independently so one provider operation
 * cannot take down the whole market section.
 */
export async function loadContinuousMarketPrice({
  instrument,
  quote,
  candles,
}: ContinuousMarketInput): Promise<OverviewPrice> {
  const resolved = await resolveContinuousAcceptedMarketData({ instrument, quote, candles });
  const sparkline = resolved.candles.map((candle) => candle.close);

  if (resolved.accepted) {
    return {
      symbol: instrument.symbol,
      instrument,
      price: resolved.accepted.price,
      currency: resolved.currency ?? instrument.currency,
      change: resolved.change,
      changePercent: resolved.changePercent,
      session: 'CONTINUOUS',
      sessionLabel: CONTINUOUS_MARKET_SESSION_LABEL,
      status: overviewPriceStatus(resolved.freshness, false),
      asOf: resolved.accepted.exchangeTimestamp,
      source: [resolved.provider, resolved.accepted.source].filter(Boolean).join(' · '),
      unavailableReason: null,
      tradingDate: resolved.accepted.exchangeTimestamp?.slice(0, 10) ?? null,
      extended: null,
      freshness: resolved.freshness,
      sparkline,
    };
  }

  return unavailable(instrument, resolved.failures);
}
