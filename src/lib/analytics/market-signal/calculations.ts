import { calculateSupportResistance, confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { calculateTechnicalAnalysis } from '@/src/lib/analytics/technical/calculations';
import type { AdxPoint, IndicatorPoint, MacdPoint } from '@/src/lib/analytics/technical/types';
import type {
  MarketSignalCandle,
  MarketSignalComponent,
  MarketSignalComponentId,
  MarketSignalContext,
  MarketSignalIndicators,
  MarketSignalReason,
  MarketSignalResult,
} from './types';

const WEIGHTS = { trend: 30, momentum: 25, volume: 20, structure: 25 } as const;
const EXPECTED_FACTORS = { trend: 6, momentum: 3, volume: 3, structure: 3 } as const;
const MINIMUM_SIGNAL_CANDLES = 50;

interface Factor {
  id: string;
  score: number;
  text: string;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function latest<T extends IndicatorPoint>(result: { status: string; latest?: T }): T | null {
  return result.status === 'available' && result.latest ? result.latest : null;
}

function slope(points: readonly IndicatorPoint[], lookback: number): number | null {
  if (points.length <= lookback) return null;
  const current = points.at(-1)!.value;
  const previous = points.at(-(lookback + 1))!.value;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function comparisonFactor(id: string, value: number, reference: number, label: string): Factor {
  const score = value > reference ? 1 : value < reference ? -1 : 0;
  return {
    id,
    score,
    text: score > 0
      ? `ราคาอยู่เหนือ ${label}`
      : score < 0 ? `ราคาอยู่ต่ำกว่า ${label}` : `ราคาอยู่เท่ากับ ${label}`,
  };
}

function component(id: MarketSignalComponentId, factors: readonly Factor[]): MarketSignalComponent {
  const score = factors.length
    ? round(clamp(factors.reduce((sum, factor) => sum + factor.score, 0) / factors.length, -1, 1), 4)
    : null;
  return {
    score,
    weight: WEIGHTS[id],
    coverage: round(Math.min(1, factors.length / EXPECTED_FACTORS[id]), 4),
    factorsUsed: factors.length,
  };
}

function emptyComponents(): Record<MarketSignalComponentId, MarketSignalComponent> {
  return {
    trend: component('trend', []),
    momentum: component('momentum', []),
    volume: component('volume', []),
    structure: component('structure', []),
  };
}

const emptyIndicators = (): MarketSignalIndicators => ({
  close: null,
  ema20: null,
  ema50: null,
  ema200: null,
  rsi14: null,
  macd: null,
  macdSignal: null,
  macdHistogram: null,
  relativeVolume20: null,
  obvTrend: null,
  adx14: null,
  plusDi14: null,
  minusDi14: null,
  nearestSupport: null,
  nearestResistance: null,
});

function reasonsFromFactors(factors: readonly Factor[], cautions: readonly MarketSignalReason[]): MarketSignalReason[] {
  const directional = factors
    .filter((factor) => Math.abs(factor.score) >= 0.2)
    .map((factor): MarketSignalReason => ({
      id: factor.id,
      polarity: factor.score > 0 ? 'positive' : 'negative',
      text: factor.text,
      impact: round(Math.abs(factor.score), 3),
    }));
  const positives = directional
    .filter((reason) => reason.polarity === 'positive')
    .sort((left, right) => right.impact - left.impact || left.id.localeCompare(right.id))
    .slice(0, 3);
  const negatives = directional
    .filter((reason) => reason.polarity === 'negative')
    .sort((left, right) => right.impact - left.impact || left.id.localeCompare(right.id))
    .slice(0, 3);
  return [...positives, ...negatives, ...cautions.slice(0, 2)];
}

export function calculateMarketSignal(
  candles: readonly MarketSignalCandle[],
  context: MarketSignalContext,
): MarketSignalResult {
  const finalized = candles
    .filter((candle) => candle.finalized)
    .map(({ finalized: _finalized, ...candle }) => candle);
  const base = {
    timeframe: '1D' as const,
    calculatedAt: context.calculatedAt,
    latestCandleAt: finalized.at(-1)?.date ?? null,
    source: context.source,
    freshness: context.freshness,
    dataPoints: { received: candles.length, finalized: finalized.length },
  };

  if (finalized.length < MINIMUM_SIGNAL_CANDLES) {
    return {
      ...base,
      status: 'insufficient-data',
      signal: null,
      score: null,
      confidence: 'Insufficient',
      confidencePct: 0,
      components: emptyComponents(),
      reasons: [],
      indicators: emptyIndicators(),
      reason: `ต้องมี finalized 1D candles อย่างน้อย ${MINIMUM_SIGNAL_CANDLES} แท่ง แต่มี ${finalized.length} แท่ง`,
    };
  }

  const technicalContext = {
    symbol: context.symbol,
    source: context.source,
    freshness: context.freshness,
    calculatedAt: context.calculatedAt,
  };
  const technical = calculateTechnicalAnalysis(finalized, technicalContext);
  if (technical.status !== 'available') {
    return {
      ...base,
      status: 'insufficient-data',
      signal: null,
      score: null,
      confidence: 'Insufficient',
      confidencePct: 0,
      components: emptyComponents(),
      reasons: [],
      indicators: emptyIndicators(),
      reason: technical.reason,
    };
  }

  const close = finalized.at(-1)!.close;
  const previousClose = finalized.at(-2)!.close;
  const ema20Result = technical.indicators.ema;
  const ema50Result = technical.indicators.ema50;
  const ema200Result = technical.indicators.ema200;
  const ema20 = latest<IndicatorPoint>(ema20Result)?.value ?? null;
  const ema50 = latest<IndicatorPoint>(ema50Result)?.value ?? null;
  const ema200 = latest<IndicatorPoint>(ema200Result)?.value ?? null;
  const rsi14 = latest<IndicatorPoint>(technical.indicators.rsi)?.value ?? null;
  const macdLatest = latest<MacdPoint>(technical.indicators.macd);
  const macdHistogram = macdLatest?.histogram !== null && macdLatest?.histogram !== undefined
    ? Math.abs(macdLatest.histogram) < 1e-10 ? 0 : macdLatest.histogram
    : null;
  const adxLatest = latest<AdxPoint>(technical.indicators.adx);
  const obv = technical.indicators.obv.status === 'available' ? technical.indicators.obv.points : [];
  const obvSlope = slope(obv, Math.min(10, Math.max(1, obv.length - 1)));
  const obvTrend = obvSlope === null ? null : obvSlope > 0 ? 'rising' as const : obvSlope < 0 ? 'falling' as const : 'flat' as const;
  const trailingVolumes = finalized.slice(-21, -1).map((candle) => candle.volume);
  const averageVolume20 = trailingVolumes.length === 20 && trailingVolumes.every((volume): volume is number => volume !== null)
    ? trailingVolumes.reduce((sum, volume) => sum + volume, 0) / 20
    : null;
  const latestVolume = finalized.at(-1)!.volume;
  const relativeVolume20 = latestVolume !== null && averageVolume20 && averageVolume20 > 0
    ? latestVolume / averageVolume20 : null;

  const trendFactors: Factor[] = [];
  if (ema20 !== null) trendFactors.push(comparisonFactor('price-ema20', close, ema20, 'EMA20'));
  if (ema50 !== null) trendFactors.push(comparisonFactor('price-ema50', close, ema50, 'EMA50'));
  if (ema200 !== null) trendFactors.push(comparisonFactor('price-ema200', close, ema200, 'EMA200'));
  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    const alignment = close > ema20 && ema20 > ema50 && ema50 > ema200
      ? 1 : close < ema20 && ema20 < ema50 && ema50 < ema200 ? -1 : 0;
    trendFactors.push({
      id: 'ema-alignment',
      score: alignment,
      text: alignment > 0
        ? 'EMA เรียงตัวขาขึ้น: ราคา > EMA20 > EMA50 > EMA200'
        : alignment < 0
          ? 'EMA เรียงตัวขาลง: ราคา < EMA20 < EMA50 < EMA200'
          : 'EMA ยังไม่เรียงตัวเป็นแนวโน้มเดียวกัน',
    });
  }
  if (ema20Result.status === 'available') {
    const value = slope(ema20Result.points, 5);
    if (value !== null) trendFactors.push({ id: 'ema20-slope', score: Math.sign(value), text: `ความชัน EMA20 ${value > 0 ? 'เป็นบวก' : value < 0 ? 'เป็นลบ' : 'ทรงตัว'}` });
  }
  if (ema50Result.status === 'available') {
    const value = slope(ema50Result.points, 10);
    if (value !== null) trendFactors.push({ id: 'ema50-slope', score: Math.sign(value), text: `ความชัน EMA50 ${value > 0 ? 'เป็นบวก' : value < 0 ? 'เป็นลบ' : 'ทรงตัว'}` });
  }
  const trend = component('trend', trendFactors);

  const momentumFactors: Factor[] = [];
  const cautions: MarketSignalReason[] = [];
  if (rsi14 !== null) {
    let rsiScore: number;
    if (rsi14 >= 70) {
      rsiScore = trend.score !== null && trend.score > 0 ? 0.25 : trend.score !== null && trend.score < 0 ? -0.25 : 0;
      cautions.push({ id: 'rsi-hot', polarity: 'caution', text: `RSI ${round(rsi14, 1)} — Momentum ค่อนข้างร้อน`, impact: 0 });
    } else if (rsi14 <= 30) {
      rsiScore = trend.score !== null && trend.score < 0 ? -0.25 : trend.score !== null && trend.score > 0 ? 0.25 : 0;
      cautions.push({ id: 'rsi-oversold', polarity: 'caution', text: `RSI ${round(rsi14, 1)} — Momentum อยู่ในเขตต่ำ`, impact: 0 });
    } else {
      rsiScore = clamp((rsi14 - 50) / 15, -1, 1);
    }
    momentumFactors.push({ id: 'rsi14', score: rsiScore, text: `RSI14 อยู่ที่ ${round(rsi14, 1)}` });
  }
  if (macdLatest?.signal !== null && macdLatest?.signal !== undefined) {
    momentumFactors.push({
      id: 'macd-signal',
      score: macdLatest.value > macdLatest.signal ? 1 : macdLatest.value < macdLatest.signal ? -1 : 0,
      text: macdLatest.value > macdLatest.signal ? 'MACD อยู่เหนือ Signal' : macdLatest.value < macdLatest.signal ? 'MACD อยู่ต่ำกว่า Signal' : 'MACD เท่ากับ Signal',
    });
  }
  if (macdHistogram !== null) {
    momentumFactors.push({
      id: 'macd-histogram',
      score: Math.sign(macdHistogram),
      text: `MACD Histogram ${macdHistogram > 0 ? 'เป็นบวก' : macdHistogram < 0 ? 'เป็นลบ' : 'เป็นศูนย์'}`,
    });
  }

  const pivots = confirmedSwingPivots(finalized, 3);
  const highs = pivots.filter((pivot) => pivot.kind === 'high');
  const lows = pivots.filter((pivot) => pivot.kind === 'low');
  const resistance = highs
    .filter((pivot) => pivot.price >= previousClose)
    .sort((left, right) => left.price - right.price)[0] ?? null;
  const support = lows
    .filter((pivot) => pivot.price <= previousClose)
    .sort((left, right) => right.price - left.price)[0] ?? null;
  const breakout = resistance !== null && previousClose <= resistance.price && close > resistance.price * 1.001;
  const breakdown = support !== null && previousClose >= support.price && close < support.price * 0.999;
  const volumeConfirmed = relativeVolume20 !== null && relativeVolume20 >= 1.2;

  const structureFactors: Factor[] = [];
  if (highs.length >= 2) {
    const pair = highs.slice(-2);
    structureFactors.push({ id: 'swing-highs', score: pair[1].price > pair[0].price ? 1 : pair[1].price < pair[0].price ? -1 : 0, text: pair[1].price > pair[0].price ? 'เกิด Higher High' : pair[1].price < pair[0].price ? 'เกิด Lower High' : 'Swing High ทรงตัว' });
  }
  if (lows.length >= 2) {
    const pair = lows.slice(-2);
    structureFactors.push({ id: 'swing-lows', score: pair[1].price > pair[0].price ? 1 : pair[1].price < pair[0].price ? -1 : 0, text: pair[1].price > pair[0].price ? 'เกิด Higher Low' : pair[1].price < pair[0].price ? 'เกิด Lower Low' : 'Swing Low ทรงตัว' });
  }
  if (breakout && volumeConfirmed) {
    structureFactors.push({ id: 'structure-breakout', score: 2, text: 'Breakout แนวต้านได้รับการยืนยันด้วย Volume' });
  } else if (breakdown && volumeConfirmed) {
    structureFactors.push({ id: 'structure-breakdown', score: -2, text: 'Breakdown แนวรับได้รับการยืนยันด้วย Volume' });
  } else if (breakout || breakdown) {
    cautions.push({ id: 'structure-volume-unconfirmed', polarity: 'caution', text: `${breakout ? 'Breakout' : 'Breakdown'} ยังไม่มี Relative Volume ยืนยัน`, impact: 0 });
  }

  const volumeFactors: Factor[] = [];
  if (relativeVolume20 !== null) {
    const priceDirection = Math.sign(close - finalized.at(-6)!.close);
    const confirmedDirection = relativeVolume20 >= 1.2 ? priceDirection : 0;
    volumeFactors.push({
      id: 'relative-volume',
      score: confirmedDirection,
      text: `Relative Volume เทียบค่าเฉลี่ย 20 วัน = ${round(relativeVolume20, 2)}×${confirmedDirection === 0 ? ' (ยังไม่ยืนยันทิศทาง)' : ''}`,
    });
  }
  if (obvTrend !== null) {
    volumeFactors.push({ id: 'obv-trend', score: obvTrend === 'rising' ? 1 : obvTrend === 'falling' ? -1 : 0, text: `OBV ${obvTrend === 'rising' ? 'มีแนวโน้มสูงขึ้น' : obvTrend === 'falling' ? 'มีแนวโน้มลดลง' : 'ทรงตัว'}` });
  }
  if ((breakout || breakdown) && volumeConfirmed) {
    volumeFactors.push({ id: 'volume-structure-confirmation', score: breakout ? 1 : -1, text: `Volume ยืนยัน ${breakout ? 'breakout' : 'breakdown'}` });
  }

  const factors = [...trendFactors, ...momentumFactors, ...volumeFactors, ...structureFactors];
  const components = {
    trend,
    momentum: component('momentum', momentumFactors),
    volume: component('volume', volumeFactors),
    structure: component('structure', structureFactors),
  };
  const available = Object.entries(components)
    .filter((entry): entry is [MarketSignalComponentId, MarketSignalComponent] => entry[1].score !== null);
  const availableWeight = available.reduce((sum, [id]) => sum + WEIGHTS[id], 0);
  if (availableWeight < 50) {
    return {
      ...base,
      status: 'insufficient-data',
      signal: null,
      score: null,
      confidence: 'Insufficient',
      confidencePct: 0,
      components,
      reasons: reasonsFromFactors(factors, cautions),
      indicators: emptyIndicators(),
      reason: 'ข้อมูล indicator ที่คำนวณได้ยังครอบคลุมน้ำหนักไม่ถึง 50%',
    };
  }
  const score = round(available.reduce((sum, [id, value]) => sum + (value.score as number) * WEIGHTS[id], 0) / availableWeight * 100, 0);
  const signal = score >= 25 ? 'bullish' as const : score <= -25 ? 'bearish' as const : 'neutral' as const;
  let confidenceRatio = Object.entries(components).reduce((sum, [id, value]) => sum + value.coverage * WEIGHTS[id as MarketSignalComponentId], 0) / 100;
  if (adxLatest && adxLatest.value >= 25 && signal !== 'neutral') {
    const dmiDirection = adxLatest.plusDi > adxLatest.minusDi ? 1 : adxLatest.plusDi < adxLatest.minusDi ? -1 : 0;
    const signalDirection = signal === 'bullish' ? 1 : -1;
    confidenceRatio += dmiDirection === signalDirection ? 0.05 : -0.05;
  }
  const confidencePct = Math.round(clamp(confidenceRatio, 0, 1) * 100);
  const confidence = confidencePct >= 85 ? 'High' as const : confidencePct >= 60 ? 'Medium' as const : 'Low' as const;
  const supportResistance = calculateSupportResistance(finalized, technicalContext);
  const nearestSupport = supportResistance.status === 'available'
    ? supportResistance.zones.find((zone) => zone.type === 'support')?.midpoint ?? null : null;
  const nearestResistance = supportResistance.status === 'available'
    ? supportResistance.zones.find((zone) => zone.type === 'resistance')?.midpoint ?? null : null;
  const indicators: MarketSignalIndicators = {
    close,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd: macdLatest?.value ?? null,
    macdSignal: macdLatest?.signal ?? null,
    macdHistogram,
    relativeVolume20,
    obvTrend,
    adx14: adxLatest?.value ?? null,
    plusDi14: adxLatest?.plusDi ?? null,
    minusDi14: adxLatest?.minusDi ?? null,
    nearestSupport,
    nearestResistance,
  };

  return {
    ...base,
    status: 'available',
    signal,
    score,
    confidence,
    confidencePct,
    components,
    reasons: reasonsFromFactors(factors, cautions),
    indicators,
  };
}
