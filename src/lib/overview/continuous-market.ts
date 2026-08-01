import { MarketDataError } from '@/src/lib/market-data/errors';
import type { NormalizedCandleResult } from '@/src/lib/market-data/candles';
import type { ProviderResult, Quote } from '@/src/lib/market-data/types';
import { overviewPriceStatus } from './presentation';
import type { InstrumentMetadata, OverviewPrice } from './types';

export const CONTINUOUS_MARKET_SESSION_LABEL = 'ซื้อขายตลอด 24 ชม.';

type ContinuousMarketInput = {
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
  const [quoteResult, candleResult] = await Promise.allSettled([quote, candles]);
  const candleData = candleResult.status === 'fulfilled'
    ? usableCandles(instrument, candleResult.value)
    : [];
  const sparkline = candleData.map((candle) => candle.close);

  if (
    quoteResult.status === 'fulfilled'
    && canonical(quoteResult.value.data.symbol) === canonical(instrument.symbol)
    && Number.isFinite(quoteResult.value.data.price)
    && quoteResult.value.data.price > 0
  ) {
    const { data, freshness } = quoteResult.value;
    const previousClose = data.previousRegularClose ?? data.previousClose;
    const change = data.change ?? (
      previousClose !== null && previousClose !== undefined
        ? data.price - previousClose
        : null
    );
    const changePercent = data.changePercent ?? (
      change !== null && previousClose !== null && previousClose !== undefined && previousClose > 0
        ? change / previousClose * 100
        : null
    );
    return {
      symbol: instrument.symbol,
      instrument,
      price: data.price,
      currency: data.currency ?? (
        candleResult.status === 'fulfilled'
          ? candleResult.value.data.currency ?? instrument.currency
          : instrument.currency
      ),
      change,
      changePercent,
      session: 'CONTINUOUS',
      sessionLabel: CONTINUOUS_MARKET_SESSION_LABEL,
      status: overviewPriceStatus(freshness, false),
      asOf: data.quoteTimestamp ?? freshness.asOf,
      source: [quoteResult.value.provider, data.priceSource].filter(Boolean).join(' · '),
      unavailableReason: null,
      tradingDate: data.latestTradingDay,
      extended: null,
      freshness,
      sparkline,
    };
  }

  if (candleResult.status === 'fulfilled' && candleData.length) {
    const first = candleData[0]!;
    const last = candleData.at(-1)!;
    const change = candleData.length > 1 ? last.close - first.close : null;
    return {
      symbol: instrument.symbol,
      instrument,
      price: last.close,
      currency: candleResult.value.data.currency ?? instrument.currency,
      change,
      changePercent: change === null || first.close <= 0 ? null : change / first.close * 100,
      session: 'CONTINUOUS',
      sessionLabel: CONTINUOUS_MARKET_SESSION_LABEL,
      status: overviewPriceStatus(candleResult.value.freshness, false),
      asOf: new Date(last.timestamp * 1_000).toISOString(),
      source: `${candleResult.value.provider ?? candleResult.value.data.provider} · candle fallback`,
      unavailableReason: null,
      tradingDate: null,
      extended: null,
      freshness: candleResult.value.freshness,
      sparkline,
    };
  }

  return unavailable(instrument, [
    quoteResult.status === 'rejected'
      ? quoteResult.reason
      : new MarketDataError('invalid-provider-response', 'Continuous quote symbol or price was invalid'),
    candleResult.status === 'rejected'
      ? candleResult.reason
      : new MarketDataError('insufficient-data', 'Continuous candles were empty or invalid'),
  ]);
}
