import type { HistoricalPrice } from '@/src/lib/market-data/types';
import type {
  BollingerPoint,
  KeltnerPoint,
  AdxPoint,
  IndicatorPoint,
  IndicatorResult,
  MacdPoint,
  StochasticPoint,
  IchimokuPoint,
  TechnicalAnalysis,
  TechnicalCandles,
  TechnicalContext,
  TechnicalParameters,
} from './types';
import { DEFAULT_TECHNICAL_PARAMETERS, technicalParametersSchema } from './validation';

const METHODOLOGY = 'Deterministic technical indicators calculated from daily OHLCV' as const;
const LIMITATIONS = [
  'Indicators describe historical price and volume; they do not predict future returns.',
  'Daily candles can omit intraday movement and provider adjustments may affect values.',
  'The latest value may change when the provider publishes a newer or adjusted candle.',
];

function unavailable(actualDataPoints: number, minimumDataPoints: number, reason?: string) {
  return {
    status: 'unavailable' as const,
    reason: reason ?? `ต้องมีข้อมูลอย่างน้อย ${minimumDataPoints} แท่ง แต่มี ${actualDataPoints} แท่ง`,
    minimumDataPoints,
    actualDataPoints,
  };
}

function available<T>(points: T[]): IndicatorResult<T> {
  if (!points.length) return unavailable(0, 1, 'ไม่สามารถคำนวณผลลัพธ์ที่เป็นค่าจำกัดได้');
  return { status: 'available', points, latest: points[points.length - 1] };
}

function assertPeriod(period: number) {
  if (!Number.isInteger(period) || period < 2) throw new RangeError('Period must be an integer of at least 2');
}

export function sma(values: readonly number[], period: number): Array<number | null> {
  assertPeriod(period);
  const result = Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

export function ema(values: readonly number[], period: number): Array<number | null> {
  assertPeriod(period);
  const result = Array<number | null>(values.length).fill(null);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;
  for (let index = period; index < values.length; index += 1) {
    result[index] = values[index] * multiplier + (result[index - 1] as number) * (1 - multiplier);
  }
  return result;
}

export function rsiWilder(values: readonly number[], period: number): Array<number | null> {
  assertPeriod(period);
  const result = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0; let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0); losses += Math.max(-change, 0);
  }
  let averageGain = gains / period; let averageLoss = losses / period;
  const value = () => averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - (100 / (1 + averageGain / averageLoss));
  result[period] = value();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
    result[index] = value();
  }
  return result;
}

export function macd(values: readonly number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  if (fastPeriod >= slowPeriod) throw new RangeError('Fast period must be less than slow period');
  const fast = ema(values, fastPeriod); const slow = ema(values, slowPeriod);
  const macdLine = values.map((_, index) => fast[index] == null || slow[index] == null ? null : (fast[index] as number) - (slow[index] as number));
  const availableMacd = macdLine.slice(slowPeriod - 1) as number[];
  const compactSignal = ema(availableMacd, signalPeriod);
  const signal = Array<number | null>(values.length).fill(null);
  compactSignal.forEach((value, index) => { signal[index + slowPeriod - 1] = value; });
  return { macd: macdLine, signal, histogram: macdLine.map((value, index) => value == null || signal[index] == null ? null : value - (signal[index] as number)) };
}

export function bollingerBands(values: readonly number[], period: number, standardDeviations: number) {
  assertPeriod(period);
  const middle = sma(values, period);
  return values.map((_, index) => {
    if (index < period - 1) return null;
    const mean = middle[index] as number;
    const variance = values.slice(index - period + 1, index + 1).reduce((sum, value) => sum + ((value - mean) ** 2), 0) / period;
    const offset = Math.sqrt(variance) * standardDeviations;
    return { upper: mean + offset, middle: mean, lower: mean - offset };
  });
}

export function atrWilder(candles: TechnicalCandles, period: number): Array<number | null> {
  assertPeriod(period);
  const result = Array<number | null>(candles.length).fill(null);
  if (candles.length < period) return result;
  const trueRanges = candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)));
  result[period - 1] = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < candles.length; index += 1) result[index] = (((result[index - 1] as number) * (period - 1)) + trueRanges[index]) / period;
  return result;
}

export function keltnerChannels(
  candles: TechnicalCandles,
  period: number,
  atrPeriod: number,
  atrMultiplier: number,
) {
  assertPeriod(period);
  assertPeriod(atrPeriod);
  if (!Number.isFinite(atrMultiplier) || atrMultiplier <= 0) {
    throw new RangeError('ATR multiplier must be a positive finite number');
  }
  const typicalPrices = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const middle = ema(typicalPrices, period);
  const atr = atrWilder(candles, atrPeriod);
  return candles.map((_, index) => {
    if (middle[index] === null || atr[index] === null) return null;
    const offset = (atr[index] as number) * atrMultiplier;
    return {
      upper: (middle[index] as number) + offset,
      middle: middle[index] as number,
      lower: (middle[index] as number) - offset,
    };
  });
}

function rollingMidpoint(candles: TechnicalCandles, period: number): Array<number | null> {
  assertPeriod(period);
  return candles.map((_, index) => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    return (Math.max(...window.map((candle) => candle.high)) + Math.min(...window.map((candle) => candle.low))) / 2;
  });
}

export function stochastic(candles: TechnicalCandles, period: number, smoothK: number, smoothD: number) {
  assertPeriod(period);
  const rawK = candles.map((candle, index) => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    return high === low ? 50 : ((candle.close - low) / (high - low)) * 100;
  });
  const compactK = rawK.slice(period - 1) as number[];
  const smoothedK = Array<number | null>(period - 1).fill(null).concat(smoothK === 1 ? compactK : sma(compactK, smoothK));
  const firstK = period + smoothK - 2;
  const compactD = smoothedK.slice(firstK) as number[];
  const d = Array<number | null>(firstK).fill(null).concat(smoothD === 1 ? compactD : sma(compactD, smoothD));
  return { k: smoothedK, d };
}

export function adxWilder(candles: TechnicalCandles, period: number) {
  assertPeriod(period);
  const length = candles.length;
  const tr = Array<number>(length).fill(0); const plusDm = Array<number>(length).fill(0); const minusDm = Array<number>(length).fill(0);
  for (let index = 1; index < length; index += 1) {
    const up = candles[index].high - candles[index - 1].high;
    const down = candles[index - 1].low - candles[index].low;
    plusDm[index] = up > down && up > 0 ? up : 0; minusDm[index] = down > up && down > 0 ? down : 0;
    tr[index] = Math.max(candles[index].high - candles[index].low, Math.abs(candles[index].high - candles[index - 1].close), Math.abs(candles[index].low - candles[index - 1].close));
  }
  const plusDi = Array<number | null>(length).fill(null); const minusDi = Array<number | null>(length).fill(null); const dx = Array<number | null>(length).fill(null); const adx = Array<number | null>(length).fill(null);
  if (length <= period) return { adx, plusDi, minusDi };
  let smoothedTr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothedPlus = plusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothedMinus = minusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  for (let index = period; index < length; index += 1) {
    if (index > period) {
      smoothedTr = smoothedTr - smoothedTr / period + tr[index];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[index];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[index];
    }
    plusDi[index] = smoothedTr === 0 ? 0 : 100 * smoothedPlus / smoothedTr;
    minusDi[index] = smoothedTr === 0 ? 0 : 100 * smoothedMinus / smoothedTr;
    const total = (plusDi[index] as number) + (minusDi[index] as number);
    dx[index] = total === 0 ? 0 : 100 * Math.abs((plusDi[index] as number) - (minusDi[index] as number)) / total;
  }
  const firstAdx = period * 2 - 1;
  if (length > firstAdx) {
    adx[firstAdx] = (dx.slice(period, firstAdx + 1) as number[]).reduce((a, b) => a + b, 0) / period;
    for (let index = firstAdx + 1; index < length; index += 1) adx[index] = (((adx[index - 1] as number) * (period - 1)) + (dx[index] as number)) / period;
  }
  return { adx, plusDi, minusDi };
}

export function onBalanceVolume(candles: TechnicalCandles): number[] {
  const values = Array<number>(candles.length).fill(0);
  for (let index = 1; index < candles.length; index += 1) values[index] = values[index - 1] + (candles[index].close > candles[index - 1].close ? candles[index].volume as number : candles[index].close < candles[index - 1].close ? -(candles[index].volume as number) : 0);
  return values;
}

export function rateOfChange(values: readonly number[], period: number): Array<number | null> {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('Period must be a positive integer');
  return values.map((value, index) => index < period || values[index - period] === 0 ? null : ((value / values[index - period]) - 1) * 100);
}

export function ichimoku(candles: TechnicalCandles, conversionPeriod: number, basePeriod: number, spanPeriod: number, displacement: number) {
  const conversion = rollingMidpoint(candles, conversionPeriod); const base = rollingMidpoint(candles, basePeriod); const spanBSource = rollingMidpoint(candles, spanPeriod);
  const leadingA = candles.map((_, index) => index < displacement || conversion[index - displacement] == null || base[index - displacement] == null ? null : ((conversion[index - displacement] as number) + (base[index - displacement] as number)) / 2);
  const leadingB = candles.map((_, index) => index < displacement ? null : spanBSource[index - displacement]);
  return { conversion, base, leadingA, leadingB };
}

function points(candles: TechnicalCandles, values: Array<number | null>): IndicatorPoint[] {
  return values.flatMap((value, index) => value == null || !Number.isFinite(value) ? [] : [{ date: candles[index].date, value }]);
}

function calculate<T>(candles: TechnicalCandles, minimum: number, build: () => T[]): IndicatorResult<T> {
  if (candles.length < minimum) return unavailable(candles.length, minimum);
  return available(build().filter((point) => Object.values(point as object).every((value) => typeof value !== 'number' || Number.isFinite(value))));
}

function candlesAreValid(candles: TechnicalCandles) {
  return candles.every((candle, index) =>
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    && candle.high >= candle.low
    && (candle.volume == null || (Number.isFinite(candle.volume) && candle.volume >= 0))
    && (index === 0 || candle.date > candles[index - 1].date));
}

export function calculateTechnicalAnalysis(
  candles: TechnicalCandles,
  context: TechnicalContext,
  input: Partial<TechnicalParameters> = {},
): TechnicalAnalysis {
  const parameters = technicalParametersSchema.parse({ ...DEFAULT_TECHNICAL_PARAMETERS, ...input });
  const calculatedAt = context.calculatedAt ?? new Date().toISOString();
  const base = {
    symbol: context.symbol,
    input: { priceField: parameters.priceField, candleCount: candles.length, interval: '1d' as const },
    dataSource: context.source,
    source: context.source,
    sourceType: 'provider/cache historical OHLCV' as const,
    dataPoints: candles.length,
    latestDataAt: candles.at(-1)?.date ?? null,
    calculatedAt,
    methodology: METHODOLOGY,
    parameters,
    freshness: context.freshness,
    limitations: LIMITATIONS,
    assumptions: ['Candles are chronological daily OHLCV from the selected historical provider/cache response.', 'Price-based indicators use raw close unless the validated priceField parameter explicitly changes it.'],
  };
  if (!candles.length || !candlesAreValid(candles)) {
    return { status: 'unavailable', ...base, reason: candles.length ? 'ข้อมูล OHLCV ไม่ถูกต้องหรือไม่ได้เรียงตามเวลา' : 'ไม่มีข้อมูล OHLCV สำหรับคำนวณ' };
  }
  const values = candles.map((candle) => candle[parameters.priceField]);
  const macdValues = macd(values, parameters.macdFastPeriod, parameters.macdSlowPeriod, parameters.macdSignalPeriod);
  const bandValues = bollingerBands(values, parameters.bollingerPeriod, parameters.bollingerStdDev);
  const keltnerValues = keltnerChannels(candles, parameters.keltnerPeriod, parameters.keltnerAtrPeriod, parameters.keltnerAtrMultiplier);
  const stochasticValues = stochastic(candles, parameters.stochasticPeriod, parameters.stochasticSmoothK, parameters.stochasticSmoothD);
  const adxValues = adxWilder(candles, parameters.adxPeriod);
  const ichimokuValues = ichimoku(candles, parameters.ichimokuConversionPeriod, parameters.ichimokuBasePeriod, parameters.ichimokuSpanPeriod, parameters.ichimokuDisplacement);
  const macdMinimum = parameters.macdSlowPeriod + parameters.macdSignalPeriod - 1;
  const volumeComplete = candles.every((candle) => candle.volume != null);
  const volumes = volumeComplete ? candles.map((candle) => candle.volume as number) : [];
  const volumeUnavailable = (minimum: number) => unavailable(candles.length, minimum, 'Volume unavailable: provider data is missing volume for one or more canonical time slots');
  return {
    status: 'available',
    ...base,
    latestDataAt: candles[candles.length - 1].date,
    indicators: {
      sma: calculate(candles, parameters.smaPeriod, () => points(candles, sma(values, parameters.smaPeriod))),
      sma50: calculate(candles, 50, () => points(candles, sma(values, 50))),
      sma100: calculate(candles, 100, () => points(candles, sma(values, 100))),
      sma200: calculate(candles, 200, () => points(candles, sma(values, 200))),
      ema: calculate(candles, parameters.emaPeriod, () => points(candles, ema(values, parameters.emaPeriod))),
      ema50: calculate(candles, 50, () => points(candles, ema(values, 50))),
      ema100: calculate(candles, 100, () => points(candles, ema(values, 100))),
      ema200: calculate(candles, 200, () => points(candles, ema(values, 200))),
      rsi: calculate(candles, parameters.rsiPeriod + 1, () => points(candles, rsiWilder(values, parameters.rsiPeriod))),
      macd: calculate(candles, macdMinimum, () => macdValues.macd.flatMap((value, index): MacdPoint[] => value == null ? [] : [{ date: candles[index].date, value, signal: macdValues.signal[index], histogram: macdValues.histogram[index] }])),
      bollinger: calculate(candles, parameters.bollingerPeriod, () => bandValues.flatMap((value, index): BollingerPoint[] => value == null ? [] : [{ date: candles[index].date, value: value.middle, ...value }])),
      keltner: calculate(candles, Math.max(parameters.keltnerPeriod, parameters.keltnerAtrPeriod), () => keltnerValues.flatMap((value, index): KeltnerPoint[] => value == null ? [] : [{ date: candles[index].date, value: value.middle, ...value }])),
      atr: calculate(candles, parameters.atrPeriod, () => points(candles, atrWilder(candles, parameters.atrPeriod))),
      volume: volumeComplete ? available(candles.map((candle) => ({ date: candle.date, value: candle.volume as number }))) : volumeUnavailable(1),
      averageVolume: volumeComplete ? calculate(candles, parameters.averageVolumePeriod, () => points(candles, sma(volumes, parameters.averageVolumePeriod))) : volumeUnavailable(parameters.averageVolumePeriod),
      averageVolume50: volumeComplete ? calculate(candles, 50, () => points(candles, sma(volumes, 50))) : volumeUnavailable(50),
      stochastic: calculate(candles, parameters.stochasticPeriod + parameters.stochasticSmoothK - 1, () => stochasticValues.k.flatMap((value, index): StochasticPoint[] => value == null ? [] : [{ date: candles[index].date, value, k: value, d: stochasticValues.d[index] }])),
      adx: calculate(candles, parameters.adxPeriod * 2, () => adxValues.adx.flatMap((value, index): AdxPoint[] => value == null ? [] : [{ date: candles[index].date, value, plusDi: adxValues.plusDi[index] as number, minusDi: adxValues.minusDi[index] as number }])),
      obv: volumeComplete ? calculate(candles, 2, () => points(candles, onBalanceVolume(candles))) : volumeUnavailable(2),
      ichimoku: calculate(candles, parameters.ichimokuSpanPeriod + parameters.ichimokuDisplacement, () => ichimokuValues.conversion.flatMap((value, index): IchimokuPoint[] => value == null || ichimokuValues.base[index] == null ? [] : [{ date: candles[index].date, value, conversion: value, base: ichimokuValues.base[index] as number, leadingA: ichimokuValues.leadingA[index], leadingB: ichimokuValues.leadingB[index] }])),
      roc: calculate(candles, parameters.rocPeriod + 1, () => points(candles, rateOfChange(values, parameters.rocPeriod))),
      vwap: unavailable(candles.length, 1, 'Unavailable: แหล่งข้อมูลนี้มีเฉพาะ daily OHLCV และไม่มี session boundaries จริง จึงไม่คำนวณ session VWAP'),
    },
  };
}
