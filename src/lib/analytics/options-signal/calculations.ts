import { lastUsSessionClose, usTradingSessionsBetween } from '@/src/lib/market-data/us-market-calendar';
import {
  directedDistanceText,
  distanceAtrText,
  distanceExpectedMovesText,
} from '@/src/lib/presentation/distance';
import {
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_CONFIG_VERSION,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
import { measureCompleteness } from './input-registry';
import type {
  IvLevel,
  IvPricingInput,
  LiquidityGrade,
  LiquidityInput,
  MacroInput,
  MomentumInput,
  OptionsSignalDiagnostics,
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  OptionsSignalLiquidityDiagnostics,
  OptionsSignalPenalty,
  OptionsSignalProvenance,
  OptionsSignalProvenanceSummary,
  OptionsSignalReason,
  OptionsSignalResult,
  OptionsSignalType,
  RiskRewardInput,
  SentimentInput,
  SuggestedOptionsSetup,
  TrendInput,
  UnderlyingBias,
} from './types';

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/**
 * The single guard between arithmetic and the UI.
 *
 * A provider that returns a zero price, an empty candle window or a `NaN` must
 * reach the card as an honest `null` — an em dash the reader understands —
 * rather than as `NaN`, `Infinity` or `undefined`, all of which render as
 * garbage or crash a `toFixed`. Every number that leaves this module passes
 * through here.
 */
const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const round = (value: number, digits = 2) => {
  const safe = finite(value);
  return safe === null ? 0 : Number(safe.toFixed(digits));
};

/** `round`, but an unusable input stays absent instead of collapsing to zero. */
const roundOrNull = (value: number | null | undefined, digits = 2): number | null => {
  const safe = finite(value);
  return safe === null ? null : Number(safe.toFixed(digits));
};

const HOUR_MS = 3_600_000;

const FACTOR_LABELS: Record<OptionsSignalFactorId, string> = {
  macro: 'Macro',
  trend: 'Trend',
  momentum: 'Momentum',
  sentiment: 'Options Sentiment',
  riskReward: 'Risk/Reward',
};

const SETUP_WARNINGS = [
  'ตรวจสภาพคล่องก่อนเสมอ: Open Interest และ Volume ต่ำทำให้เข้า-ออกยาก',
  'ดูส่วนต่าง Bid/Ask ถ้ากว้างมาก ต้นทุนจริงจะสูงกว่าที่เห็น',
  'ถ้า Implied Volatility สูง ค่าพรีเมียมจะแพงและเสี่ยง IV Crush',
  'หลีกเลี่ยงการถือข้ามวันประกาศงบ ถ้ายังไม่เข้าใจความเสี่ยงของ event',
];

const DISCLAIMER_REASON: OptionsSignalReason = {
  id: 'disclaimer',
  polarity: 'information',
  text: 'Confidence คือความหนักแน่นของหลักฐาน ไม่ใช่ความน่าจะเป็นที่จะได้กำไร',
};

/** Open interest is a standing book, most of it hedges. Said every single time. */
const OI_HEDGE_NOTE = 'Open Interest ส่วนมากเป็นการป้องกันความเสี่ยง (hedge) ไม่ใช่การเดิมพันทิศทาง';

// ---------------------------------------------------------------------------
// Factor scoring — each returns a signed value in [-1, 1] or null.
// ---------------------------------------------------------------------------

export interface FactorOutcome {
  normalized: number | null;
  detail: string;
  partial: boolean;
  /**
   * Set when the factor had raw data but no context to judge it against, so the
   * value it produced is a fallback rather than a measurement. See
   * {@link OptionsSignalFactorMeasurement}. The text is the reason, printed on
   * the card in place of a score.
   *
   * Absent or null means the factor was measured — including when it measured
   * zero, which is a finding and keeps its weight.
   */
  fallbackReason?: string | null;
}

export function scoreMacro(input: MacroInput): FactorOutcome & {
  benchmarks: Array<{ symbol: string; close: number; ema20: number | null; aboveEma20: boolean | null }>;
} {
  const benchmarks = input.benchmarks.map((benchmark) => ({
    symbol: benchmark.symbol,
    close: benchmark.close,
    ema20: finite(benchmark.ema20),
    aboveEma20: finite(benchmark.ema20) === null ? null : benchmark.close > (benchmark.ema20 as number),
  }));
  const usable = benchmarks.filter((benchmark) => benchmark.ema20 !== null && finite(benchmark.close) !== null);
  if (!usable.length) {
    return { normalized: null, detail: 'ไม่มีดัชนีอ้างอิงที่คำนวณ EMA20 ได้', partial: false, benchmarks };
  }
  const votes = usable.map((benchmark) => Math.sign(benchmark.close - (benchmark.ema20 as number)));
  const normalized = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  const above = usable.filter((benchmark) => benchmark.aboveEma20).map((benchmark) => benchmark.symbol);
  const below = usable.filter((benchmark) => benchmark.aboveEma20 === false).map((benchmark) => benchmark.symbol);
  const detail = normalized > 0
    ? `ตลาดโดยรวมยังแข็งแรง: ${above.join(' และ ')} อยู่เหนือ EMA20`
    : normalized < 0
      ? `ตลาดโดยรวมอ่อนแรง: ${below.join(' และ ')} อยู่ใต้ EMA20`
      : 'ดัชนีอ้างอิงยังขัดแย้งกัน (ขึ้นหนึ่ง ลงหนึ่ง)';
  return {
    normalized,
    detail,
    partial: usable.length < input.benchmarks.length,
    benchmarks,
  };
}

export function scoreTrend(input: TrendInput): FactorOutcome {
  const close = finite(input.close);
  const ema20 = finite(input.ema20);
  const ema50 = finite(input.ema50);
  const votes: number[] = [];
  if (close !== null && ema20 !== null) votes.push(Math.sign(close - ema20));
  if (close !== null && ema50 !== null) votes.push(Math.sign(close - ema50));
  if (ema20 !== null && ema50 !== null) votes.push(Math.sign(ema20 - ema50));
  if (!votes.length) {
    return { normalized: null, detail: 'คำนวณ EMA20/EMA50 จากแท่งที่ปิดแล้วไม่ได้', partial: false };
  }
  const normalized = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  const detail = normalized > 0
    ? 'ราคายืนเหนือเส้นค่าเฉลี่ยและ EMA เรียงตัวขาขึ้น'
    : normalized < 0
      ? 'ราคาอยู่ใต้เส้นค่าเฉลี่ยและ EMA เรียงตัวขาลง'
      : 'ราคากับเส้นค่าเฉลี่ยยังพันกัน ไม่มีทิศทางชัด';
  return { normalized, detail, partial: ema50 === null };
}

export interface MomentumOutcome extends FactorOutcome {
  normalizedMomentum: number | null;
  /** True when the raw |momentum ÷ ATR| exceeded 1 and the value shown is the clamp. */
  normalizedMomentumCapped: boolean;
  confirmation: number | null;
  /**
   * Every term between the raw indicator and the published points, in order.
   *
   * Written down because the factor's own sentence could not previously explain
   * its own number: "ไม่มี Squeeze · RVOL 0.92× · ยืนยัน 38%" was printed beside
   * +19 of a possible 25, and nothing in those words says where 76% of the full
   * weight came from. It came from a momentum of 3.19 ATR clamped to 1.00, which
   * the reader was never shown. These are the terms of `rawAtr -> capped ->
   * squeeze adjustment -> × multiplier = normalized`, and they multiply out.
   */
  breakdown: {
    /**
     * Raw TTM momentum in ATR UNITS, before anything is done to it.
     *
     * Genuinely `momentum ÷ ATR14`, not `momentum ÷ (ATR14 × saturation)`. The
     * two were the same number while the saturation was 1.0 and stopped being
     * the same number when it widened to 3.5 — and the factor's own sentence
     * prints this value followed by the word "ATR", so it has to be the one the
     * word describes.
     */
    rawAtr: number | null;
    /** The ATR multiple at which the factor reaches full weight. */
    saturation: number;
    /** `rawAtr ÷ saturation`, clamped to ±1. Before the squeeze state adjusts it. */
    clamped: number | null;
    /** After squeeze damping or a fired-release bonus. */
    afterSqueeze: number | null;
    /** The RVOL confirmation multiplier actually applied. Never flips a sign. */
    multiplier: number;
  };
}

/**
 * RVOL confirmation as a continuous logistic curve centred on average volume.
 *
 * The old linear ramp started at exactly 1.0x, so 0.99x scored 0% and 1.01x
 * scored 2% — a cliff placed precisely where a 20-day volume average is least
 * meaningful, and the reason a perfectly ordinary 0.81x session was reported as
 * "0% confirmation". This never reaches 0% or 100%, and 0.99x and 1.01x differ
 * by about three points.
 */
export function rvolConfirmation(
  relativeVolume: number,
  config = OPTIONS_SIGNAL_CONFIG.momentum,
): number {
  const value = finite(relativeVolume);
  if (value === null) return 0;
  return 1 / (1 + Math.exp(-config.rvolSteepness * (value - config.rvolMidpoint)));
}

/**
 * The RVOL curve, written out — WHICH curve, and the substitution.
 *
 * The card said "เป็นเส้นโค้งต่อเนื่องรอบ 1.00×" and stopped there, so the step
 * from "RVOL 1.06× → ยืนยัน 58%" to "ตัวคูณ 0.83" had no stated derivation at
 * all. It is a LOGISTIC curve, and naming it is what lets a reader work out that
 * 1.06 sits barely above the midpoint and therefore barely above 50%.
 *
 * Both constants come from the config the arithmetic reads.
 */
export function rvolConfirmationFormula(
  relativeVolume: number | null,
  config = OPTIONS_SIGNAL_CONFIG.momentum,
): string {
  const shape = `เส้นโค้งโลจิสติก: ยืนยัน = 1 ÷ (1 + e^(−${config.rvolSteepness} × (RVOL − ${config.rvolMidpoint.toFixed(2)})))`;
  const value = finite(relativeVolume);
  if (value === null) return shape;
  const confirmation = rvolConfirmation(value, config);
  /*
   * And the second step, which was the one with no stated derivation: the
   * confirmation is not the multiplier. It is mapped onto the band between
   * `minimumConfirmation` and 1, so a 58% confirmation lands at 0.83 rather than
   * at 0.58 — the factor is scaled, never cancelled.
   */
  const multiplier = config.minimumConfirmation + (1 - config.minimumConfirmation) * confirmation;
  return `${shape}`
    + ` · แทนค่า RVOL ${round(value, 2)} → ยืนยัน ${Math.round(confirmation * 100)}%`
    + ` · ตัวคูณ = ${config.minimumConfirmation} + ${round(1 - config.minimumConfirmation, 2)} × ${round(confirmation, 2)}`
    + ` = ${round(multiplier, 2)}`;
}

export function scoreMomentum(
  input: MomentumInput,
  config = OPTIONS_SIGNAL_CONFIG.momentum,
): MomentumOutcome {
  const squeezeMomentum = finite(input.squeezeMomentum);
  const atr = finite(input.atr);
  /*
   * Two separate numbers, deliberately. `momentumAtr` is the measurement in the
   * units the card names — ATR — and `rawNormalized` is that measurement placed
   * on the factor's own [-1, 1] scale by the saturation. They were one
   * expression while the saturation was 1.0, which made them the same number by
   * coincidence rather than by meaning; at 3.5 the coincidence ends and the
   * sentence that prints "N ATR" needs the first of them.
   */
  const momentumAtr = squeezeMomentum !== null && atr !== null && atr > 0
    ? squeezeMomentum / atr
    : null;
  const rawNormalized = momentumAtr === null ? null : momentumAtr / config.momentumAtrSaturation;
  const normalizedMomentum = rawNormalized === null ? null : clamp(rawNormalized, -1, 1);
  const normalizedMomentumCapped = rawNormalized !== null && Math.abs(rawNormalized) > 1;

  let base = normalizedMomentum;
  if (input.squeeze === 'ON' && base !== null) base *= config.squeezeOnDamping;
  // A confirmed release is directional EVIDENCE; a squeeze that is still ON is
  // compression and never becomes bullish on its own.
  if (input.squeeze === 'FIRED_BULLISH') base = clamp((base ?? 0) + config.firedBonus, -1, 1);
  if (input.squeeze === 'FIRED_BEARISH') base = clamp((base ?? 0) - config.firedBonus, -1, 1);

  if (base === null) {
    return {
      normalized: null,
      detail: 'คำนวณ TTM Squeeze Momentum จากแท่งที่ปิดแล้วไม่ได้',
      partial: false,
      normalizedMomentum,
      normalizedMomentumCapped,
      confirmation: null,
      breakdown: {
        rawAtr: momentumAtr,
        saturation: config.momentumAtrSaturation,
        clamped: normalizedMomentum,
        afterSqueeze: null,
        multiplier: 1,
      },
    };
  }

  // Relative volume describes ACTIVITY, so it can only scale a direction that
  // already exists — it can never create or flip one.
  const relativeVolume = finite(input.relativeVolume);
  const confirmation = relativeVolume === null ? null : rvolConfirmation(relativeVolume, config);
  const multiplier = confirmation === null
    ? config.unconfirmedMultiplier
    : config.minimumConfirmation + (1 - config.minimumConfirmation) * confirmation;

  const squeezeText = input.squeeze === 'ON'
    ? 'TTM Squeeze กำลัง ON (บีบตัว ยังไม่เลือกทาง)'
    : input.squeeze === 'FIRED_BULLISH'
      ? 'Squeeze ปลดล็อกขึ้น'
      : input.squeeze === 'FIRED_BEARISH'
        ? 'Squeeze ปลดล็อกลง'
        : 'ไม่มี Squeeze';
  const volumeText = relativeVolume === null
    ? 'ไม่มีข้อมูล RVOL ยืนยัน'
    : `RVOL ${round(relativeVolume, 2)}× · ยืนยัน ${Math.round((confirmation ?? 0) * 100)}%`;

  /*
   * The arithmetic, printed.
   *
   * The clamp used to fire on 22 of the 30 regression tickers, so for most
   * symbols most days the published momentum was the CEILING and not the
   * measurement. Widening the saturation from 1.0 to 3.5 ATR took that to 4 of
   * 30, but "usually" is not "never" and a factor that is sitting on its own
   * maximum still has to say so — otherwise the reader is left to infer a large
   * number from three small ones.
   *
   * `momentumText` is the raw reading IN ATR, with the ceiling disclosed beside
   * it when it was reached; `mathText` is the last multiplication, so the points
   * printed next to it can be checked by hand.
   */
  const momentumText = momentumAtr === null
    ? 'ไม่มีค่าโมเมนตัมเทียบ ATR'
    : normalizedMomentumCapped
      ? `โมเมนตัม ${round(momentumAtr, 2)} ATR (เกินเพดาน ${round(config.momentumAtrSaturation, 2)} ATR จึงคิดเท่าเพดาน)`
      : `โมเมนตัม ${round(momentumAtr, 2)} ATR (เพดาน ${round(config.momentumAtrSaturation, 2)} ATR)`;
  const mathText = `คิดเป็น ${round(base, 2)} × ตัวคูณ ${round(multiplier, 2)} = ${round(clamp(base * multiplier, -1, 1), 2)} ของน้ำหนักเต็ม`;

  return {
    normalized: clamp(base * multiplier, -1, 1),
    detail: `${squeezeText} · ${momentumText} · ${volumeText} · ${mathText}`,
    partial: relativeVolume === null,
    normalizedMomentum,
    normalizedMomentumCapped,
    confirmation,
    breakdown: {
      rawAtr: momentumAtr,
      saturation: config.momentumAtrSaturation,
      clamped: normalizedMomentum,
      afterSqueeze: base,
      multiplier,
    },
  };
}

/** Positioning read off the absolute Put/Call bands. Cross-symbol, so blunt. */
function putCallBandScore(ratio: number, config = OPTIONS_SIGNAL_CONFIG.sentiment): number {
  if (ratio <= config.bullishBelow) {
    return clamp((config.bullishBelow - ratio) / (config.bullishBelow - config.bullishSaturation), 0, 1);
  }
  if (ratio >= config.bearishAbove) {
    return -clamp((ratio - config.bearishAbove) / (config.bearishSaturation - config.bearishAbove), 0, 1);
  }
  return 0;
}

/** Positioning read against this symbol's OWN recent readings. The preferred basis. */
function putCallPercentileScore(percentile: number, config = OPTIONS_SIGNAL_CONFIG.sentiment): number {
  const value = clamp(percentile, 0, 1);
  if (value <= config.percentileNeutralLow) {
    return clamp((config.percentileNeutralLow - value) / config.percentileNeutralLow, 0, 1);
  }
  if (value >= config.percentileNeutralHigh) {
    return -clamp((value - config.percentileNeutralHigh) / (1 - config.percentileNeutralHigh), 0, 1);
  }
  return 0;
}

/**
 * Options positioning.
 *
 * A raw Put/Call of 1.51 is meaningless across symbols — it is routine on one
 * ticker and an outlier on another — so the reading is expressed against this
 * symbol's OWN recent history whenever enough of it has been recorded, and the
 * absolute bands are used only as a disclosed fallback. Traded volume, when the
 * chain carries it, is averaged in: open interest is an accumulated book, volume
 * is today's flow, and they answer different questions.
 */
export function scoreSentiment(
  input: SentimentInput,
  /**
   * True when the reading history could not be READ at all, as opposed to being
   * short. The two states share a fallback — the absolute bands — and share
   * nothing else, and this factor's own sentence has to say which one it is in.
   */
  options: { historyUnavailable?: boolean } = {},
  config = OPTIONS_SIGNAL_CONFIG.sentiment,
): FactorOutcome {
  const ratio = finite(input.putCallRatio);
  if (ratio === null) {
    return { normalized: null, detail: 'Put/Call Ratio ที่ได้รับไม่ใช่ตัวเลขที่ใช้ได้', partial: false };
  }
  const observations = input.percentileObservations ?? 0;
  const percentile = observations >= config.minimumPercentileObservations
    ? finite(input.ownPercentile)
    : null;

  const openInterestSignal = percentile === null
    ? putCallBandScore(ratio, config)
    : putCallPercentileScore(percentile, config);
  const volumeRatio = finite(input.volumeRatio);
  const volumeSignal = volumeRatio === null ? null : putCallBandScore(volumeRatio, config);
  const normalized = volumeSignal === null
    ? openInterestSignal
    : (openInterestSignal + volumeSignal) / 2;

  /*
   * THREE states, and the counter belongs to exactly one of them.
   *
   * A store that cannot be read is not part-way through collecting anything, so
   * "มีประวัติ 0/20 วัน" beside an outage badge is a countdown that will never
   * move — the same lie the card-level notice was split in two to avoid, told
   * one line further down. No count, no denominator, no "ยัง" in the outage
   * sentence: this factor reads its state from the same flag the badge does.
   */
  const basisText = options.historyUnavailable === true
    ? 'อ่านประวัติของหุ้นตัวนี้ไม่สำเร็จ จึงเทียบเปอร์เซ็นไทล์ไม่ได้ชั่วคราว และใช้เกณฑ์กลางแทน'
    : percentile === null
      ? `ยังเทียบเปอร์เซ็นไทล์ของตัวเองไม่ได้ (มีประวัติ ${observations}/${config.minimumPercentileObservations} วัน) จึงใช้เกณฑ์กลางไปก่อน`
      : `เปอร์เซ็นไทล์ที่ ${Math.round(percentile * 100)} ของ ${observations} วันล่าสุดของหุ้นตัวนี้เอง`;
  const positionText = percentile === null
    ? ''
    : percentile >= config.percentileNeutralHigh
      ? ' · ฝั่ง Put หนากว่าที่หุ้นตัวนี้เคยเป็น'
      : percentile <= config.percentileNeutralLow
        ? ' · ฝั่ง Call หนากว่าที่หุ้นตัวนี้เคยเป็น'
        : ' · อยู่ในช่วงปกติของหุ้นตัวนี้';
  const volumeText = volumeRatio === null ? '' : ` · Put/Call Volume ${round(volumeRatio, 2)}`;

  return {
    normalized: clamp(normalized, -1, 1),
    detail: `Put/Call OI ${round(ratio, 2)}${volumeText} · ${basisText}${positionText} · ${OI_HEDGE_NOTE}`,
    // A reading without the symbol's own history is a reading on a weaker basis,
    // and the card says so rather than presenting it as a complete measurement.
    partial: percentile === null,
    /*
     * No percentile basis means no baseline, and no baseline means this factor
     * cannot be judged at all — the absolute bands are a shape to fall back to,
     * not a measurement of this symbol.
     *
     * It used to score anyway and keep its 10 points in the divisor, so a
     * centred Put/Call published "0 / 10" and pulled the whole card toward 50
     * with nothing behind it. `fallbackReason` is what takes those 10 points out
     * of both sides of the fraction.
     */
    fallbackReason: percentile !== null
      ? null
      : options.historyUnavailable === true
        ? 'อ่านประวัติของหุ้นตัวนี้ไม่สำเร็จ จึงไม่มีฐานเทียบเปอร์เซ็นไทล์'
        : `ยังไม่มี baseline: ประวัติ ${observations}/${config.minimumPercentileObservations} วัน`,
  };
}

export type RiskRewardSide = 'call' | 'put' | null;

export interface RiskRewardOutcome extends FactorOutcome {
  upsidePercent: number | null;
  downsidePercent: number | null;
  callRewardRisk: number | null;
  putRewardRisk: number | null;
  scoredSide: RiskRewardSide;
  setupQuality: number | null;
  upsideAtr: number | null;
  downsideAtr: number | null;
  upsideExpectedMoves: number | null;
  downsideExpectedMoves: number | null;
  expectedMove: number | null;
  expectedMoveDte: number | null;
  expectedMoveHorizonWarning: string | null;
  /**
   * How much of the scored side's geometry survived the reachability test, in
   * (0, 1]. 1 when the target sits inside the expected move, or when there is no
   * expected move to judge it against.
   */
  reachability: number;
}

/** How workable a side is on its own terms: 0 at 1:1, 1 at the saturation ratio. */
function setupQualityOf(ratio: number | null, saturationRatio: number): number | null {
  if (ratio === null || ratio <= 0) return null;
  return clamp(Math.log(ratio) / Math.log(saturationRatio), 0, 1);
}

/**
 * Score the geometry — for the side the rest of the evidence actually points at.
 *
 * The old version always measured the CALL side, so a chart with a 0.24 call R:R
 * and a 4.23 put R:R took the full -15 even when nothing else was bearish and
 * even when the put side was the excellent setup. Geometry is not a market
 * opinion; it is the quality of a trade in a given direction, and it can only be
 * scored once a direction exists:
 *
 *  - a direction from the other four factors -> score THAT side's reward:risk;
 *  - no direction at all -> there is no side to score, so the factor reports the
 *    quality of the best available side and contributes only a damped residual
 *    tilt, never a full-weight vote.
 */
export function scoreRiskReward(
  input: RiskRewardInput,
  options: { direction?: UnderlyingBias } = {},
  config = OPTIONS_SIGNAL_CONFIG.riskReward,
  expectedMoveConfig = OPTIONS_SIGNAL_CONFIG.expectedMove,
): RiskRewardOutcome {
  const empty: RiskRewardOutcome = {
    normalized: null,
    detail: 'ไม่มีแนวรับหรือแนวต้านที่ยืนยันได้',
    partial: false,
    upsidePercent: null,
    downsidePercent: null,
    callRewardRisk: null,
    putRewardRisk: null,
    scoredSide: null,
    setupQuality: null,
    upsideAtr: null,
    downsideAtr: null,
    upsideExpectedMoves: null,
    downsideExpectedMoves: null,
    expectedMove: null,
    expectedMoveDte: null,
    expectedMoveHorizonWarning: null,
    reachability: 1,
  };
  const price = finite(input.price);
  if (price === null || price <= 0) return empty;
  const support = finite(input.support);
  const resistance = finite(input.resistance);
  if (support === null && resistance === null) return empty;

  const direction = options.direction ?? 'neutral';
  const rawUpside = resistance === null ? null : (resistance - price) / price * 100;
  const rawDownside = support === null ? null : (price - support) / price * 100;
  // A level the price is already sitting on is a touch, not a target.
  const upside = rawUpside === null ? null : Math.max(0, rawUpside < config.minimumDistancePercent ? 0 : rawUpside);
  const downside = rawDownside === null ? null : Math.max(0, rawDownside < config.minimumDistancePercent ? 0 : rawDownside);

  const callRewardRisk = upside !== null && downside !== null && downside > 0 ? upside / downside : null;
  const putRewardRisk = upside !== null && downside !== null && upside > 0 ? downside / upside : null;

  const atr = finite(input.atr);
  const expectedMove = finite(input.expectedMove);
  const inAtr = (distancePercent: number | null): number | null => (
    distancePercent === null || atr === null || atr <= 0 ? null : distancePercent / 100 * price / atr
  );
  const inExpectedMoves = (distancePercent: number | null): number | null => (
    distancePercent === null || expectedMove === null || expectedMove <= 0
      ? null
      : distancePercent / 100 * price / expectedMove
  );

  const expectedMoveDte = finite(input.expectedMoveDte);
  const upsideExpectedMoves = inExpectedMoves(upside);
  const downsideExpectedMoves = inExpectedMoves(downside);

  /*
   * A level further away than the straddle's own pricing says price can reach
   * before expiry is not a target with a worse reward — it is a target this
   * contract is the wrong instrument for, and a Risk:Reward measured against it
   * flatters the setup. Said out loud rather than left in the ratio.
   */
  const beyond = [
    upsideExpectedMoves !== null && upsideExpectedMoves > expectedMoveConfig.reachableWithin
      ? `แนวต้านอยู่ไกล ${round(upsideExpectedMoves, 2)} เท่าของ Expected Move`
      : null,
    downsideExpectedMoves !== null && downsideExpectedMoves > expectedMoveConfig.reachableWithin
      ? `แนวรับอยู่ไกล ${round(downsideExpectedMoves, 2)} เท่าของ Expected Move`
      : null,
  ].filter((part): part is string => part !== null);
  /*
   * The warning stays, and it now describes something that HAPPENED rather than
   * something the reader has to correct for themselves. The old sentence said
   * the ratio "ดูดีเกินจริง" beside a factor that had just published its full
   * value anyway; the score is scaled for it below, so the sentence says that.
   */
  const expectedMoveHorizonWarning = beyond.length === 0
    ? null
    : `${beyond.join(' และ ')} · สัญญาที่ใช้อ้างอิงเหลืออายุ ${expectedMoveDte ?? '—'} วัน `
      + 'ราคาจึงมีโอกาสน้อยที่จะไปถึงก่อนหมดอายุ คะแนน R:R ฝั่งที่ใช้ตัดสินจึงถูกลดทอนตามสัดส่วนแล้ว';

  /*
   * How much of a side's geometry is actually reachable before expiry.
   *
   * `reachableWithin` expected moves is full weight; past it the contribution
   * falls off as `reachableWithin / distance`, so a target 3 expected moves away
   * carries half and one 15 away carries a tenth. It never reaches zero and it
   * never changes a sign: the level is real, the ratio measured against it is
   * real, and what is in doubt is whether this instrument lives long enough for
   * either to matter.
   *
   * Same function for both sides, so the put and call frames stay mirrors.
   */
  const reachabilityOf = (distanceInExpectedMoves: number | null): number => {
    if (distanceInExpectedMoves === null || distanceInExpectedMoves <= expectedMoveConfig.reachableWithin) return 1;
    return clamp(expectedMoveConfig.reachableWithin / distanceInExpectedMoves, 0, 1);
  };

  const geometry = {
    upsidePercent: upside,
    downsidePercent: downside,
    callRewardRisk,
    putRewardRisk,
    upsideAtr: inAtr(upside),
    downsideAtr: inAtr(downside),
    upsideExpectedMoves,
    downsideExpectedMoves,
    expectedMove,
    expectedMoveDte,
    expectedMoveHorizonWarning,
    partial: upside === null || downside === null,
  };

  /*
   * Both distances written the same way, by the one formatter.
   *
   * This line used to negate the downside — `percent(-downside)` — so the modal
   * printed `ลงถึงแนวรับ -6.23%` two lines above a row that printed the same
   * distance as `+6.23%`, and a third call site below printed it as `+6.23%`
   * again. A distance to a level does not have a sign; the label carries the
   * direction and the number carries the magnitude.
   */
  const distanceText = [
    upside === null ? null : `${directedDistanceText('up', 'แนวต้าน', upside)}${geometry.upsideAtr === null ? '' : ` (${distanceAtrText(geometry.upsideAtr)})`}`,
    downside === null ? null : `${directedDistanceText('down', 'แนวรับ', downside)}${geometry.downsideAtr === null ? '' : ` (${distanceAtrText(geometry.downsideAtr)})`}`,
  ].filter((part): part is string => part !== null).join(' · ');

  // A missing level on one side is unbounded on THAT side: no confirmed
  // resistance overhead is clear runway up, and no confirmed support beneath is
  // open downside. The two cases are exact mirrors of each other and no
  // direction can change what an absent level means.
  if (upside === null) {
    return {
      ...geometry,
      normalized: 1,
      detail: `ไม่พบแนวต้านเหนือราคา (ราคาอยู่บริเวณจุดสูงสุด) · ${distanceText}`,
      scoredSide: 'call',
      setupQuality: 1,
      // No level at all is not a level too far away; there is nothing to reach.
      reachability: 1,
    };
  }
  if (downside === null) {
    return {
      ...geometry,
      normalized: -1,
      detail: `ไม่พบแนวรับใต้ราคา · ความเสี่ยงฝั่งลงเปิดกว้าง · ${distanceText}`,
      scoredSide: 'put',
      setupQuality: 1,
      reachability: 1,
    };
  }
  if (upside === 0 && downside === 0) {
    return { ...geometry, normalized: 0, detail: 'ราคาติดทั้งแนวรับและแนวต้าน', scoredSide: null, setupQuality: 0, reachability: 1 };
  }
  if (downside === 0) {
    return {
      ...geometry,
      normalized: reachabilityOf(upsideExpectedMoves),
      detail: `ราคาอยู่ที่แนวรับ ${directedDistanceText('up', 'แนวต้าน', upside)}`,
      scoredSide: 'call',
      setupQuality: 1,
      reachability: reachabilityOf(upsideExpectedMoves),
    };
  }
  if (upside === 0) {
    return {
      ...geometry,
      normalized: -reachabilityOf(downsideExpectedMoves),
      detail: `ราคาอยู่ที่แนวต้าน ${directedDistanceText('down', 'แนวรับ', downside)}`,
      scoredSide: 'put',
      setupQuality: 1,
      reachability: reachabilityOf(downsideExpectedMoves),
    };
  }

  const callQuality = setupQualityOf(callRewardRisk, config.saturationRatio);
  const putQuality = setupQualityOf(putRewardRisk, config.saturationRatio);
  const bestRatio = Math.max(callRewardRisk ?? 0, putRewardRisk ?? 0);
  const bestQuality = Math.max(callQuality ?? 0, putQuality ?? 0);
  const ratioText = `R:R Call ${round(callRewardRisk as number, 2)} · R:R Put ${round(putRewardRisk as number, 2)}`;
  const expectedMoveText = geometry.upsideExpectedMoves === null || geometry.downsideExpectedMoves === null
    ? ''
    : ` · เทียบ Expected Move (${expectedMoveDte ?? '—'} วัน): ขึ้น ${distanceExpectedMovesText(geometry.upsideExpectedMoves)} `
      + `ลง ${distanceExpectedMovesText(geometry.downsideExpectedMoves)}`;

  /*
   * The signed tilt of the geometry, on the call frame of reference.
   *
   * `log(rr) / log(base)` is symmetric by construction — `log(1/x) = -log(x)` —
   * so the put frame below is the exact mirror of this one, and widening the
   * base makes both ends harder to reach by the same amount.
   */
  const tilt = clamp(Math.log((callRewardRisk as number)) / Math.log(config.tiltSaturationRatio), -1, 1);

  /** Said once, in the factor's own sentence, whenever the scaling actually bit. */
  const reachText = (reachability: number, distance: number | null) => (
    reachability >= 1 || distance === null
      ? ''
      : ` · เป้าหมายอยู่ไกล ${distanceExpectedMovesText(distance)} เท่าของ Expected Move `
        + `จึงคิดคะแนน R:R เพียง ${Math.round(reachability * 100)}%`
  );

  /*
   * THE SUBSTITUTION, in the same shape Momentum already prints.
   *
   * The card showed "คุณภาพ setup 80%" beside a score of +1 out of 15, and
   * nothing on the page connected the two: `80% × 15` is 12, and the two damping
   * multipliers that turn it into 1 were applied silently. A reader who tries the
   * arithmetic and cannot reproduce it stops trusting every other number beside
   * it.
   *
   * `setupQuality` is deliberately NOT a term here, because it is not one — it
   * answers "is either side of this chart a workable trade", which is a different
   * question from "how far does the geometry lean". Printing it inside the
   * multiplication would only replace an unexplained gap with a wrong
   * explanation; it is labelled separately instead.
   */
  const mathText = (terms: Array<[string, number]>, result: number) => {
    const written = terms.map(([label, value]) => `${label} ${round(value, 2)}`).join(' × ');
    return `คิดเป็น ${written} = ${round(result, 2)} ของน้ำหนักเต็ม`;
  };

  if (direction === 'bullish') {
    const reachability = reachabilityOf(upsideExpectedMoves);
    return {
      ...geometry,
      normalized: tilt * reachability,
      scoredSide: 'call',
      setupQuality: callQuality,
      reachability,
      detail: `หลักฐานอื่นชี้ขาขึ้น จึงวัดจากฝั่ง Call · ${distanceText} · ${ratioText}${expectedMoveText}`
        + reachText(reachability, upsideExpectedMoves)
        + ` · ${mathText([['เอียงฝั่ง Call', tilt], ['ตัวคูณระยะเอื้อม', reachability]], tilt * reachability)}`,
    };
  }
  if (direction === 'bearish') {
    // Mirror image: a strong PUT reward:risk is strong evidence for the bearish
    // thesis, and carries the same magnitude a strong call R:R would carry up.
    const putTilt = clamp(Math.log((putRewardRisk as number)) / Math.log(config.tiltSaturationRatio), -1, 1);
    const reachability = reachabilityOf(downsideExpectedMoves);
    return {
      ...geometry,
      normalized: -putTilt * reachability,
      scoredSide: 'put',
      setupQuality: putQuality,
      reachability,
      detail: `หลักฐานอื่นชี้ขาลง จึงวัดจากฝั่ง Put · ${distanceText} · ${ratioText}${expectedMoveText}`
        + reachText(reachability, downsideExpectedMoves)
        + ` · ${mathText([['เอียงฝั่ง Put', -putTilt], ['ตัวคูณระยะเอื้อม', reachability]], -putTilt * reachability)}`,
    };
  }

  /*
   * No direction. Geometry alone cannot supply one, so the factor reports the
   * quality of the BEST side and keeps only a damped residual of its tilt. A
   * chart with one workable side (R:R at or above `workableRatio`) can therefore
   * never take the full weight against the reader on the strength of the other,
   * unusable side's ratio.
   */
  const workable = bestRatio >= config.workableRatio;
  const qualityText = workable
    ? `ฝั่งที่ใช้ได้คือ ${(putRewardRisk ?? 0) > (callRewardRisk ?? 0) ? 'Put' : 'Call'} (R:R ${round(bestRatio, 2)}) แต่หลักฐานอื่นยังไม่เลือกทาง จึงยังไม่นับเป็นคะแนนทิศทางเต็ม`
    : 'ยังไม่มีฝั่งไหนที่ระยะทำกำไรคุ้มความเสี่ยง และหลักฐานอื่นยังไม่เลือกทาง';
  /*
   * No side was chosen, so the residual tilt is judged against the target it
   * leans toward — the resistance when it leans up, the support when it leans
   * down. Mirrored, like everything else on this path.
   */
  const residualDistance = tilt >= 0 ? upsideExpectedMoves : downsideExpectedMoves;
  const reachability = reachabilityOf(residualDistance);
  return {
    ...geometry,
    normalized: tilt * config.sidewaysDamping * reachability,
    scoredSide: null,
    setupQuality: bestQuality,
    reachability,
    detail: `${distanceText} · ${ratioText} · ${qualityText}${expectedMoveText}`
      + reachText(reachability, residualDistance)
      + ` · คุณภาพ setup ${Math.round(bestQuality * 100)}% (บอกว่ามีฝั่งที่ใช้ได้ไหม ไม่ใช่ตัวคูณของคะแนน)`
      + ` · ${mathText(
        [['เอียง', tilt], ['ตัวคูณไร้ทิศทาง', config.sidewaysDamping], ['ตัวคูณระยะเอื้อม', reachability]],
        tilt * config.sidewaysDamping * reachability,
      )}`,
  };
}

// ---------------------------------------------------------------------------
// Liquidity — a tradeability badge. Never a direction, never a weight.
// ---------------------------------------------------------------------------

export interface LiquidityOutcome {
  grade: LiquidityGrade | null;
  score: number | null;
  detail: string;
  /**
   * What the STANDING interest alone says, when the book was shut.
   *
   * Deliberately NOT a grade and NOT a score. It used to publish
   * `{ grade: 'good', score: 100 }`, and the card rendered that as a green
   * "สภาพคล่องดี · 100 / 100" badge one line under "คะแนนรวม: —". A reader
   * remembers the 100, not the dash — so the box was simultaneously refusing to
   * judge and awarding full marks.
   */
  offHoursAssessment: { standingPassed: boolean } | null;
  /**
   * The closed-book spread, kept as an UPPER BOUND rather than discarded.
   *
   * 6.18% was being thrown away whole because the market was shut. Overnight
   * spreads really are unusable for grading, but a spread that wide would still
   * be expensive at half the width, and silently dropping the observation is how
   * a reader ends up in a chain nobody can get out of.
   */
  closedSpreadWarning: string | null;
}

const liquidityVerdict = (grade: Exclude<LiquidityGrade, 'unknown'>) => (
  grade === 'good'
    ? 'เข้า-ออกได้ตามปกติ'
    : grade === 'fair'
      ? 'พอเข้า-ออกได้ แต่ควรใช้คำสั่งจำกัดราคา'
      : 'บาง เข้า-ออกยากและต้นทุนแฝงสูง'
);

/**
 * Grade the chain a reader would actually have to trade.
 *
 * The three components are averaged with any absent one dropped from BOTH the
 * numerator and the divisor, the same rule the directional factors follow.
 *
 * The one case that is not a data problem is an after-hours capture. A bid-ask
 * spread quoted while the book is shut measures the hour, not the instrument:
 * market makers widen or pull quotes overnight, and the same chain that costs
 * 2% to cross at 10:00 can quote 40% at 02:00. Calling that "ระวัง" would send a
 * reader away from a perfectly liquid contract, so the badge reports `unknown`
 * and the open-interest and volume evidence is kept beside it, labelled.
 */
export function gradeLiquidity(
  input: LiquidityInput,
  config = OPTIONS_SIGNAL_CONFIG.liquidity,
): LiquidityOutcome {
  const openInterest = finite(input.medianOpenInterest);
  const volume = finite(input.medianVolume);
  const spread = finite(input.medianSpreadPercent);
  const marketOpen = input.marketOpenAtCapture ?? null;

  const standing: number[] = [];
  if (openInterest !== null) standing.push(clamp(openInterest / config.openInterestGood, 0, 1));
  if (volume !== null) standing.push(clamp(volume / config.volumeGood, 0, 1));
  const spreadScore = spread === null
    ? null
    : clamp(
      (config.spreadPoorPercent - spread) / (config.spreadPoorPercent - config.spreadGoodPercent),
      0,
      1,
    );

  const measured = [
    openInterest === null ? null : `OI กลาง ${Math.round(openInterest).toLocaleString('en-US')}`,
    volume === null ? null : `Volume กลาง ${Math.round(volume).toLocaleString('en-US')}`,
    spread === null ? null : `ส่วนต่าง Bid/Ask ${round(spread, 1)}% ของราคากลาง`,
  ].filter((part): part is string => part !== null).join(' · ');
  const context = `สัญญาใกล้ราคาปัจจุบัน ${input.contractsExamined} สัญญา`;

  const compose = (parts: readonly number[]) => {
    if (!parts.length) return null;
    const score = round(parts.reduce((sum, part) => sum + part, 0) / parts.length * 100, 0);
    const grade: Exclude<LiquidityGrade, 'unknown'> = score >= config.goodFrom
      ? 'good'
      : score >= config.fairFrom ? 'fair' : 'thin';
    return { grade, score };
  };

  if (input.contractsExamined <= 0 || (!standing.length && spreadScore === null)) {
    return {
      grade: null,
      score: null,
      detail: 'ไม่มีข้อมูล Open Interest, Volume หรือ Bid/Ask พอจะประเมินสภาพคล่อง',
      offHoursAssessment: null,
      closedSpreadWarning: null,
    };
  }

  if (marketOpen === false) {
    const standingOnly = compose(standing);
    /*
     * ONE sentence, not a verdict beside a refusal to give one.
     *
     * The two facts are different in kind and the box has to say so in the same
     * breath: open interest and volume were measured and cleared their bar, and
     * the spread was captured while the book was shut so it cannot be graded at
     * all. Splitting them across a badge and a footnote is what let "100 / 100"
     * be the part a reader took away.
     */
    const standingPassed = standingOnly !== null && standingOnly.grade === 'good';
    const standingText = standingOnly === null
      ? 'ยังไม่มี OI หรือ Volume พอจะดู'
      : standingPassed
        ? `OI/Volume ผ่านเกณฑ์ (${Math.round(openInterest ?? 0).toLocaleString('en-US')} / ${Math.round(volume ?? 0).toLocaleString('en-US')})`
        : `OI/Volume ยังบาง (${Math.round(openInterest ?? 0).toLocaleString('en-US')} / ${Math.round(volume ?? 0).toLocaleString('en-US')})`;
    const spreadText = spread === null
      ? 'ไม่มีข้อมูลส่วนต่าง Bid/Ask'
      : `สเปรดยังตัดสินไม่ได้ — เก็บตอนตลาดปิดที่ ${round(spread, 1)}% ต้องดูซ้ำตอนเปิด`;
    const closedSpreadWarning = spread !== null && spread > config.closedSpreadWarnPercent
      ? `สเปรดกว้างผิดปกติแม้เผื่อผลของตลาดปิดแล้ว (${round(spread, 1)}% ตอนปิด) `
        + `ถ้าหดลงครึ่งหนึ่งตอนเปิดก็ยังเกินเกณฑ์ ${config.spreadGoodPercent}%`
      : null;
    return {
      grade: 'unknown',
      score: null,
      detail: `${standingText} · ${spreadText} · ${context}`
        + (closedSpreadWarning === null ? '' : ` · ${closedSpreadWarning}`),
      offHoursAssessment: standingOnly === null ? null : { standingPassed },
      closedSpreadWarning,
    };
  }

  const composed = compose(spreadScore === null ? standing : [...standing, spreadScore]);
  if (composed === null) {
    return {
      grade: null,
      score: null,
      detail: 'ไม่มีข้อมูล Open Interest, Volume หรือ Bid/Ask พอจะประเมินสภาพคล่อง',
      offHoursAssessment: null,
      closedSpreadWarning: null,
    };
  }
  return {
    grade: composed.grade,
    score: composed.score,
    detail: `${measured} · ${context} · ${liquidityVerdict(composed.grade)}`,
    offHoursAssessment: null,
    closedSpreadWarning: null,
  };
}

/**
 * Classify how expensive options premium is. This NEVER contributes a direction —
 * it only feeds the risk gate and the educational setup.
 */
export function classifyIvLevel(pricing: IvPricingInput, config = OPTIONS_SIGNAL_CONFIG.iv): IvLevel {
  if (pricing.basis === 'iv-rank') {
    if (pricing.ivRank >= config.rank.extremeFrom) return 'extreme';
    if (pricing.ivRank > config.rank.highAbove) return 'high';
    if (pricing.ivRank >= config.rank.normalFrom) return 'normal';
    return 'low';
  }
  if (pricing.basis === 'iv-percentile') {
    if (pricing.ivPercentile >= config.percentile.extremeFrom) return 'extreme';
    if (pricing.ivPercentile > config.percentile.highAbove) return 'high';
    if (pricing.ivPercentile >= config.percentile.normalFrom) return 'normal';
    return 'low';
  }
  if (pricing.ratio >= config.realized.extremeFrom) return 'extreme';
  if (pricing.ratio > config.realized.highAbove) return 'high';
  if (pricing.ratio >= config.realized.normalFrom) return 'normal';
  return 'low';
}

/**
 * The signed balance of the evidence, in [-100, 100].
 *
 * INTERNAL. This is the ruler the direction and quality thresholds in the config
 * are written on, and the only reason it still exists — it is deliberately not
 * published, because a second normalization beside the 0-100 score is what let
 * the card and its own printed arithmetic disagree.
 */
export function directionBalance(rawDirectionPoints: number, availableWeight: number): number {
  const raw = finite(rawDirectionPoints) ?? 0;
  const maxAbs = finite(availableWeight) ?? 0;
  if (maxAbs <= 0) return 0;
  return round(clamp(raw / maxAbs * 100, -100, 100), 0);
}

export function biasFromDirectionBalance(
  balance: number,
  config = OPTIONS_SIGNAL_CONFIG.direction,
): UnderlyingBias {
  if (balance >= config.bullish) return 'bullish';
  if (balance <= config.bearish) return 'bearish';
  return 'neutral';
}

/**
 * The one 0-100 direction number every surface shows.
 *
 * The card used to show confidence and the modal used to show the signed sum,
 * so the same signal read "55/100" in one place and "+13/90 -> 14" in the other.
 * There is now exactly one function that produces a published score, and both
 * surfaces read its output.
 */
export function directionScoreOutOf100(rawScore: number, maximumAbsolute: number): number {
  const raw = finite(rawScore) ?? 0;
  const maxAbs = finite(maximumAbsolute) ?? 0;
  if (maxAbs <= 0) return 50;
  return round(clamp((raw + maxAbs) / (2 * maxAbs) * 100, 0, 100), 0);
}

/**
 * THE TWO RULERS, and the one unrounded quantity underneath both.
 *
 * `directionScoreOutOf100` and `directionBalance` round INDEPENDENTLY, off the
 * same fraction, so `balance / 2 + 50` is not reliably the published score: on
 * +1 of 80 the balance rounds to +1 and the card to 51, and the identity is out
 * by half a point. Printing that identity as an equation would have been the
 * same defect this pass exists to remove, one scale further along.
 *
 * So the line prints the shared fraction FIRST and both roundings after it, and
 * a reader can land on either published number from it.
 */
export function directionScaleFormula(rawScore: number, maximumAbsolute: number): string {
  const raw = round(finite(rawScore) ?? 0, 0);
  const maxAbs = round(finite(maximumAbsolute) ?? 0, 0);
  if (maxAbs <= 0) return 'ยังไม่มีน้ำหนักที่วัดได้ จึงยังไม่มีคะแนนให้แปลงสเกล';
  const signed = (value: number) => `${value > 0 ? '+' : ''}${value}`;
  const bipolar = raw / maxAbs * 100;
  const card = bipolar / 2 + 50;
  return `${signed(raw)} ÷ ${maxAbs} × 100 = ${signed(round(bipolar, 2))}`
    + ` → สเกล ±100 ปัดเป็น ${signed(directionBalance(raw, maxAbs))}`
    + ` · ${signed(round(bipolar, 2))} ÷ 2 + 50 = ${round(card, 2)}`
    + ` → สเกล 0–100 ปัดเป็น ${directionScoreOutOf100(raw, maxAbs)}`;
}

/** The same conversion, written out for the reader. */
export function directionScoreFormula(
  rawScore: number,
  maximumAbsolute: number,
  /**
   * The trend veto, when one applied. Printed as its own step rather than folded
   * into `rawScore`, because a reader who adds up the five factor rows on the
   * card must land on the number this formula starts from — a formula that
   * silently began from an already-attenuated total would be the second time
   * this card printed arithmetic that does not reconcile with itself.
   */
  veto: { pointsBefore: number; multiplier: number } | null = null,
): string {
  const raw = round(finite(rawScore) ?? 0, 0);
  const maxAbs = round(finite(maximumAbsolute) ?? 0, 0);
  const signed = `${raw > 0 ? '+' : ''}${raw}`;
  const conversion = `(${signed} + ${maxAbs}) ÷ (2 × ${maxAbs}) × 100 = ${directionScoreOutOf100(raw, maxAbs)}`;
  if (!veto) return conversion;
  const before = round(veto.pointsBefore, 0);
  return `${before > 0 ? '+' : ''}${before} × ${round(veto.multiplier, 2)} (แนวโน้มสวนทาง) = ${signed} · ${conversion}`;
}

/**
 * How hard the trend disagrees with a direction, in [0, 1].
 *
 * 0 when the trend agrees, is flat, or was not measured. 1 when it points fully
 * the other way. Nothing else in the engine reads the trend's own sign against
 * the aggregate, so this is the one place that comparison is written down.
 */
export function trendOppositionAgainst(
  trend: { points: number | null; maxPoints: number },
  bias: UnderlyingBias,
): number {
  if (bias === 'neutral' || trend.points === null || trend.points === 0 || trend.maxPoints <= 0) return 0;
  const wanted = bias === 'bullish' ? 1 : -1;
  if (Math.sign(trend.points) === wanted) return 0;
  return clamp(Math.abs(trend.points) / trend.maxPoints, 0, 1);
}

/**
 * Confidence as a weighted geometric mean of the three quality terms.
 *
 * Multiplicative, so a collapsed term cannot be bought back by the other two —
 * which is exactly what the old weighted average allowed, publishing 62%
 * confidence on 21% agreement.
 */
export function confidenceFromTerms(
  terms: { coverage: number; agreement: number; strength: number },
  config = OPTIONS_SIGNAL_CONFIG.confidence,
): number {
  const floor = (value: number) => Math.max(config.termFloor, clamp(finite(value) ?? 0, 0, 1));
  const logSum = config.exponents.coverage * Math.log(floor(terms.coverage))
    + config.exponents.agreement * Math.log(floor(terms.agreement))
    + config.exponents.strength * Math.log(floor(terms.strength));
  return clamp(Math.exp(logSum), 0, 1);
}

/**
 * The same arithmetic, written out for the reader — the confidence twin of
 * {@link directionScoreFormula}.
 *
 * It exists because the modal described this as "การคูณกันของสามค่า", which is
 * what a weighted geometric mean is NOT: a reader who multiplied the three
 * printed percentages got `1.00 × 0.11 × 0.20 = 2%` beside a published 20%. The
 * exponents are what closes that gap, so they are printed, and they are read
 * from the same `config.exponents` the arithmetic above reads — there is no
 * second copy of them in any sentence.
 *
 * The floored terms are printed, not the raw ones, so a genuinely-zero term
 * shows the 0.01 the result was actually computed from rather than a 0.00 that
 * would make the printed line unreproducible.
 */
export function confidenceFormulaText(
  terms: { coverage: number; agreement: number; strength: number },
  config = OPTIONS_SIGNAL_CONFIG.confidence,
  /**
   * The deductions, so the sentence ends on the number the CARD shows.
   *
   * Without this the line stopped at the geometric mean. On the reported card
   * that meant section 7 printed "คะแนนก่อนหักลบ 20%" beside a headline reading
   * 5 — the same defect one step further along: a reader who follows the
   * arithmetic to the end has to land on the figure they were shown, not on an
   * intermediate the copy never named as one.
   */
  penaltyTotal = 0,
): string {
  const floor = (value: number) => Math.max(config.termFloor, clamp(finite(value) ?? 0, 0, 1));
  const parts: Array<[string, number, number]> = [
    ['ความครบ', floor(terms.coverage), config.exponents.coverage],
    ['ความสอดคล้อง', floor(terms.agreement), config.exponents.agreement],
    ['ความหนักแน่น', floor(terms.strength), config.exponents.strength],
  ];
  const result = confidenceFromTerms(terms, config);
  const names = parts.map(([name, , exponent]) => `${name}^${exponent}`).join(' × ');
  const values = parts.map(([, value, exponent]) => `${value.toFixed(2)}^${exponent}`).join(' × ');
  const base = `${names} = ${values} = ${result.toFixed(2)}`;
  const penalty = clamp(finite(penaltyTotal) ?? 0, 0, 1);
  if (penalty <= 0) return `${base} → ${Math.round(result * 100)}%`;
  const published = clamp(result - penalty, 0, 1);
  return `${base} → หักความเสี่ยง ${round(penalty, 2)}`
    + ` = ${published.toFixed(2)} → ${Math.round(published * 100)}%`;
}

/**
 * Fold every source timestamp into ONE published `asOf`, plus the honest spread.
 *
 * Sources genuinely disagree: the candle provider closes at one hour, the
 * options chain at another, the earnings calendar is a date. Showing three
 * timestamps and letting the reader pick invites them to believe the newest one.
 * The published `asOf` is therefore the OLDEST — a signal is exactly as current
 * as its stalest input — and a spread wider than the configured window raises
 * `staleMix` so the card can say the mixture out loud.
 */
export function summariseProvenance(
  slots: ReadonlyArray<{ id: string; slot: OptionsSignalInputSlot<unknown> | undefined }>,
  config = OPTIONS_SIGNAL_CONFIG.provenance,
): OptionsSignalProvenanceSummary {
  const sources = slots
    .filter((entry): entry is { id: string; slot: OptionsSignalInputSlot<unknown> } => Boolean(entry.slot))
    .map((entry) => ({
      id: entry.id,
      provider: entry.slot.provider,
      asOf: entry.slot.asOf,
      fetchedAt: entry.slot.fetchedAt ?? null,
      usable: entry.slot.status === 'available' && Number.isFinite(Date.parse(entry.slot.asOf ?? '')),
    }));

  const stamps = sources
    .filter((source) => source.usable && source.asOf !== null)
    .map((source) => ({ asOf: source.asOf as string, ms: Date.parse(source.asOf as string) }))
    .sort((left, right) => left.ms - right.ms);

  const published = sources.map(({ id, provider, asOf, fetchedAt }) => ({ id, provider, asOf, fetchedAt }));
  if (!stamps.length) {
    return {
      asOf: null, newestAsOf: null, spreadHours: null, spreadSessions: null,
      staleMix: false, sources: published,
    };
  }
  const oldest = stamps[0];
  const newest = stamps[stamps.length - 1];
  const spreadHours = stamps.length > 1 ? round((newest.ms - oldest.ms) / HOUR_MS, 2) : null;

  /*
   * The gap, measured in the only unit that answers the question.
   *
   * Hours cannot: 26.7 of them is two sessions apart on a Tuesday and ZERO
   * across a weekend, and the six-hour window was reading Saturday as though the
   * exchange were open on it. Every signal computed on a Saturday or Sunday
   * raised STALE-MIX for sources that were, in fact, two views of the same
   * Friday. The flag was up so often it had stopped meaning anything.
   *
   * Both ends are mapped to the session they belong to first, so the comparison
   * is session-to-session and never instant-to-instant. `spreadHours` survives
   * as disclosure beside it — it is still the honest wall-clock answer, it is
   * simply not the one the flag is allowed to be decided on.
   */
  const oldestSession = lastUsSessionClose(oldest.asOf);
  const newestSession = lastUsSessionClose(newest.asOf);
  const spreadSessions = oldestSession && newestSession && stamps.length > 1
    ? usTradingSessionsBetween(oldestSession.date, newestSession.date)
    : stamps.length > 1 ? null : 0;

  return {
    asOf: oldest.asOf,
    newestAsOf: newest.asOf,
    spreadHours,
    spreadSessions,
    /*
     * One session apart is genuinely stale evidence: a signal mixing Thursday's
     * chart with Friday's chain is comparing two different days of a market. The
     * same instant on both sides of a weekend is not.
     *
     * When the sessions cannot be resolved at all the wall clock is the only
     * thing left, and the old window is what it falls back to — a source with an
     * unreadable timestamp should not silently stop being checked.
     */
    staleMix: spreadSessions === null
      ? spreadHours !== null && spreadHours > config.staleMixHours
      : spreadSessions >= config.staleMixSessions,
    sources: published,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A factor that produced no score. Its data state is always `UNAVAILABLE` —
 * whether the slot was empty or the computation could not complete, the UI must
 * not present it as if a value existed.
 */
function unavailableFactor(
  id: OptionsSignalFactorId,
  slot: OptionsSignalProvenance,
  reason: string,
): OptionsSignalFactorScore {
  return {
    id,
    points: null,
    maxPoints: OPTIONS_SIGNAL_WEIGHTS[id],
    normalized: null,
    state: 'UNAVAILABLE',
    available: false,
    measurement: 'unavailable',
    fallbackReason: null,
    partial: false,
    detail: reason,
    reason,
    provider: slot.provider,
    asOf: slot.asOf,
  };
}

function scoredFactor(
  id: OptionsSignalFactorId,
  slot: OptionsSignalInputSlot<unknown>,
  outcome: FactorOutcome,
): OptionsSignalFactorScore {
  const normalized = finite(outcome.normalized);
  if (normalized === null) return unavailableFactor(id, slot, outcome.detail);
  const maxPoints = OPTIONS_SIGNAL_WEIGHTS[id];
  const fallbackReason = outcome.fallbackReason ?? null;
  return {
    id,
    /*
     * A fallback carries NO points, deliberately.
     *
     * Publishing the fallback's own number would put it back in every sum that
     * reads `points ?? 0`, and printing it beside a weight ("0 / 10") is what
     * made a missing baseline read as a measured neutral in the first place. The
     * reading itself is not lost — it is still in `detail`, described as the
     * fallback it is.
     */
    points: fallbackReason === null ? round(normalized * maxPoints, 0) : null,
    maxPoints,
    normalized: fallbackReason === null ? round(normalized, 4) : null,
    state: slot.state,
    available: true,
    measurement: fallbackReason === null ? 'measured' : 'fallback-neutral',
    fallbackReason,
    partial: outcome.partial,
    detail: outcome.detail,
    reason: null,
    provider: slot.provider,
    asOf: slot.asOf,
  };
}

/**
 * The divisor rule, in one place.
 *
 * `available` is not it and never was: a factor can have its data and still be
 * unjudgeable, and counting its weight then pulls the published score toward 50
 * on the strength of nothing.
 */
function countsTowardWeight(factor: OptionsSignalFactorScore): boolean {
  return factor.measurement === 'measured';
}

function setupWarnings(daysToEarnings: number | null, liquidity: LiquidityOutcome | null): string[] {
  const warnings = [...SETUP_WARNINGS];
  if (liquidity?.grade === 'thin') {
    warnings.push('สภาพคล่องของ chain นี้บาง การเข้า-ออกอาจเสียราคามากกว่าที่คิด');
  }
  if (liquidity?.grade === 'unknown') {
    warnings.push('ข้อมูล chain เก็บตอนตลาดปิด ให้ตรวจส่วนต่าง Bid/Ask อีกครั้งตอนตลาดเปิดก่อนเข้าสถานะ');
  }
  warnings.push(daysToEarnings === null
    ? 'ยังไม่ทราบวันประกาศงบ ให้ตรวจสอบปฏิทินของบริษัทเองก่อนเปิดสถานะ'
    : `วันประกาศงบครั้งถัดไปอีก ${daysToEarnings} วัน`);
  return warnings;
}

function buildSetup(
  signalType: OptionsSignalType,
  bias: UnderlyingBias,
  ivLevel: IvLevel | null,
  ivReason: string | null,
  daysToEarnings: number | null,
  liquidity: LiquidityOutcome | null,
  /**
   * Set when the ถูก/แพง verdict was withheld across an earnings report inside
   * the contract.
   *
   * The SHAPE below still comes from the real `ivLevel` — this change is not
   * allowed to move any behaviour, and withholding the shape would remove a
   * recommendation rather than correct a sentence. What it replaces is the
   * RATIONALE, which said "ค่าพรีเมียมยังไม่แพง จึงมีพื้นที่ให้ซื้อเวลาเผื่อไว้"
   * on a contract whose premium is mostly the report it straddles.
   */
  ivLevelSuppressedReason: string | null = null,
): SuggestedOptionsSetup {
  const warnings = setupWarnings(daysToEarnings, liquidity);
  if (ivLevelSuppressedReason) warnings.push(ivLevelSuppressedReason);
  if (signalType === 'IV_WARNING') {
    return { status: 'not-recommended', reason: 'อยู่ในสถานะเตือนความเสี่ยง (IV สูงมาก หรือใกล้ประกาศงบ) จึงยังไม่เสนอรูปแบบสัญญา', warnings };
  }
  /*
   * Both refuse a setup, and they refuse it for different reasons. A reader who
   * is told "the tape is quiet" waits; a reader who is told "the evidence is
   * fighting" knows a move may be coming and that nobody can say which way.
   */
  if (signalType === 'CONFLICTED') {
    return {
      status: 'not-recommended',
      reason: 'หลักฐานขัดกันเอง ปัจจัยหนึ่งชี้ขึ้นอีกปัจจัยชี้ลงจนหักกลบไปเกือบหมด '
        + 'คะแนนที่ออกมากลางๆ จึงไม่ได้แปลว่าตลาดเงียบ แต่แปลว่ายังไม่รู้ว่าจะไปทางไหน',
      warnings,
    };
  }
  if (signalType === 'SIDEWAYS' || bias === 'neutral') {
    return { status: 'not-recommended', reason: 'ทิศทางยังไม่ชัดเจน การซื้อ Call หรือ Put ตอนนี้คือการจ่ายค่าพรีเมียมให้กับความไม่แน่นอน', warnings };
  }
  if (ivLevel === null) {
    return { status: 'not-recommended', reason: `ยังประเมินความแพงของค่าพรีเมียมไม่ได้ (${ivReason ?? 'ไม่มีข้อมูล Implied Volatility'}) จึงไม่เสนอ DTE/Delta`, warnings };
  }
  if (ivLevel === 'high' || ivLevel === 'extreme') {
    return { status: 'not-recommended', reason: 'ค่าพรีเมียมแพงเมื่อเทียบกับความผันผวนที่ควรเป็น การซื้อ option ฝั่งเดียวเสียเปรียบ', warnings };
  }
  const shape = ivLevel === 'low' ? OPTIONS_SIGNAL_CONFIG.setup.lowIv : OPTIONS_SIGNAL_CONFIG.setup.normalIv;
  return {
    status: 'suggested',
    direction: bias === 'bullish' ? 'call' : 'put',
    dteMin: shape.dteMin,
    dteMax: shape.dteMax,
    deltaMin: shape.deltaMin,
    deltaMax: shape.deltaMax,
    rationale: ivLevelSuppressedReason
      ? 'รูปแบบด้านล่างเลือกจากอายุสัญญาและ Delta เท่านั้น ยังไม่ได้ตัดสินว่าค่าพรีเมียมคุ้มหรือไม่'
      : ivLevel === 'low'
        ? 'ค่าพรีเมียมยังไม่แพง จึงมีพื้นที่ให้ซื้อเวลาเผื่อไว้ และเลือก Delta ที่เกาะราคาหุ้นได้ดี'
        : 'ค่าพรีเมียมอยู่ระดับปกติ จึงเผื่ออายุสัญญาให้ยาวขึ้นเพื่อลดผลของ Time Decay',
    warnings,
  };
}

/** Every slot that carries provenance, in the order the modal lists them. */
function provenanceSlots(input: OptionsSignalInput) {
  return [
    { id: 'macro', slot: input.macro },
    { id: 'trend', slot: input.trend },
    { id: 'momentum', slot: input.momentum },
    { id: 'pricing', slot: input.pricing },
    { id: 'sentiment', slot: input.sentiment },
    { id: 'riskReward', slot: input.riskReward },
    { id: 'event', slot: input.event },
    { id: 'liquidity', slot: input.liquidity },
  ] as const;
}

function liquidityDiagnostics(
  slot: OptionsSignalInputSlot<LiquidityInput> | undefined,
  outcome: LiquidityOutcome | null,
): OptionsSignalLiquidityDiagnostics {
  if (!slot) {
    return {
      grade: null, score: null, medianOpenInterest: null, medianVolume: null,
      medianSpreadPercent: null, contractsExamined: null, expiration: null,
      marketOpenAtCapture: null, offHoursAssessment: null, closedSpreadWarning: null,
      state: 'UNAVAILABLE', reason: 'ยังไม่ได้โหลด options chain จึงยังประเมินสภาพคล่องไม่ได้',
      detail: 'ยังไม่ได้โหลด options chain จึงยังประเมินสภาพคล่องไม่ได้',
    };
  }
  if (slot.status === 'unavailable' || !outcome) {
    const reason = slot.status === 'unavailable' ? slot.reason : 'ประเมินสภาพคล่องไม่ได้';
    return {
      grade: null, score: null, medianOpenInterest: null, medianVolume: null,
      medianSpreadPercent: null, contractsExamined: null, expiration: null,
      marketOpenAtCapture: null, offHoursAssessment: null, closedSpreadWarning: null,
      state: 'UNAVAILABLE', reason, detail: reason,
    };
  }
  return {
    grade: outcome.grade,
    score: outcome.score,
    medianOpenInterest: roundOrNull(slot.value.medianOpenInterest, 0),
    medianVolume: roundOrNull(slot.value.medianVolume, 0),
    medianSpreadPercent: roundOrNull(slot.value.medianSpreadPercent, 2),
    contractsExamined: slot.value.contractsExamined,
    expiration: slot.value.expiration,
    marketOpenAtCapture: slot.value.marketOpenAtCapture ?? null,
    offHoursAssessment: outcome.offHoursAssessment,
    closedSpreadWarning: outcome.closedSpreadWarning,
    state: slot.state,
    reason: outcome.grade === null ? outcome.detail : null,
    detail: outcome.detail,
  };
}

function emptyDiagnostics(input: OptionsSignalInput): OptionsSignalDiagnostics {
  const factor = (id: OptionsSignalFactorId, slot: OptionsSignalInputSlot<unknown>): OptionsSignalFactorScore =>
    unavailableFactor(id, slot, slot.status === 'unavailable' ? slot.reason : 'ไม่ได้ใช้เพราะข้อมูลหลักไม่พอ');
  return {
    factors: {
      macro: factor('macro', input.macro),
      trend: factor('trend', input.trend),
      momentum: factor('momentum', input.momentum),
      sentiment: factor('sentiment', input.sentiment),
      riskReward: factor('riskReward', input.riskReward),
    },
    rawDirectionPoints: 0,
    trendVeto: { applied: false, opposition: 0, multiplier: 1, pointsBeforeVeto: 0 },
    availableWeight: 0,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    directionScore0to100: 50,
    scoreFormula: 'ไม่มีปัจจัยที่มีข้อมูลพอจะแปลงเป็นคะแนน',
    directionBalance: 0,
    directionScaleFormula: directionScaleFormula(0, 0),
    coverage: 0,
    completeness: measureCompleteness(input, {}),
    agreement: 0,
    evidenceStrength: 0,
    confidenceBase: 0,
    confidenceFormula: confidenceFormulaText({ coverage: 0, agreement: 0, strength: 0 }),
    penalties: [],
    penaltyTotal: 0,
    dataSufficiency: { passed: false, missing: [], primeEligible: false, primeBlockers: ['data-insufficient'] },
    riskReward: {
      reachability: 1,
      price: null, support: null, resistance: null, upsidePercent: null,
      downsidePercent: null, callRewardRisk: null, putRewardRisk: null,
      scoredSide: null, setupQuality: null, upsideAtr: null, downsideAtr: null,
      upsideExpectedMoves: null, downsideExpectedMoves: null, expectedMove: null,
      expectedMoveDte: null, expectedMoveHorizonWarning: null,
      state: input.riskReward.state,
    },
    iv: {
      level: null, levelSuppressedReason: null, basis: null, ivRank: null, ivPercentile: null,
      percentilePending: input.historyDegraded === true ? null : input.ivPercentilePending ?? null,
      percentileStoreUnavailable: input.historyDegraded === true,
      impliedVolatility: null, realizedVolatility: null, realizedWindowDays: null, dte: null,
      ratio: null, observations: null, state: input.pricing.state,
      reason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      source: input.pricing.provider, fetchedAt: input.pricing.asOf,
    },
    liquidity: liquidityDiagnostics(input.liquidity, null),
    event: {
      reportDate: null, daysToEarnings: null, timeOfDay: null, state: input.event.state,
      reason: input.event.status === 'unavailable' ? input.event.reason : null,
      source: input.event.provider, fetchedAt: input.event.asOf,
    },
    squeeze: {
      state: null, momentum: null, normalizedMomentum: null,
      normalizedMomentumCapped: false, relativeVolume: null, confirmation: null,
      confirmationFormula: rvolConfirmationFormula(null),
      breakdown: {
        rawAtr: null, saturation: OPTIONS_SIGNAL_CONFIG.momentum.momentumAtrSaturation,
        clamped: null, afterSqueeze: null, multiplier: 1,
      },
    },
    macro: { benchmarks: [] },
    provenance: summariseProvenance(provenanceSlots(input)),
    gates: { ivWarning: false, ivWarningReasons: [], downgrades: [] },
  };
}

/**
 * Calculate the Options Signal for one symbol.
 *
 * Pure and deterministic: identical inputs always produce identical output, no
 * clock or network is read, and any absent input stays absent — it is never
 * replaced with a neutral zero that would quietly move the score.
 *
 * The three stages are strictly separated:
 *  1. **Direction** — only the five weighted directional factors. Risk/Reward is
 *     scored in a second pass, against the direction the other four established,
 *     because geometry is the quality of a trade in a direction and has no
 *     opinion of its own.
 *  2. **Signal quality** — how much of that direction is actually evidenced.
 *  3. **Risk gate** — implied volatility and event risk, which can veto or
 *     downgrade a signal but can never create one.
 */
export function calculateOptionsSignal(input: OptionsSignalInput): OptionsSignalResult {
  const config = OPTIONS_SIGNAL_CONFIG;
  const provenance = summariseProvenance(provenanceSlots(input));
  const base = {
    symbol: input.symbol,
    timeframe: input.timeframe,
    calculatedAt: input.calculatedAt,
    latestCandleAt: input.latestCandleAt,
    finalizedCandles: input.finalizedCandles,
    asOf: provenance.asOf,
    staleMix: provenance.staleMix,
    configVersion: OPTIONS_SIGNAL_CONFIG_VERSION,
    historyDegraded: input.historyDegraded === true,
  };

  const liquidityOutcome = input.liquidity?.status === 'available'
    ? gradeLiquidity(input.liquidity.value)
    : null;

  const insufficient = (reason: string): OptionsSignalResult => ({
    ...base,
    status: 'insufficient-data',
    signalType: null,
    directionScore0to100: null,
    confidenceScore: 0,
    underlyingBias: null,
    liquidityGrade: null,
    reason,
    reasoning: [{ id: 'insufficient-data', polarity: 'caution', text: reason }, DISCLAIMER_REASON],
    suggestedOptionsSetup: {
      status: 'not-recommended',
      reason: 'ข้อมูลไม่พอสำหรับประเมินทิศทาง จึงไม่เสนอรูปแบบสัญญา',
      warnings: setupWarnings(
        input.event.status === 'available' ? finite(input.event.value.daysToEarnings) : null,
        liquidityOutcome,
      ),
    },
    diagnostics: { ...emptyDiagnostics(input), liquidity: liquidityDiagnostics(input.liquidity, liquidityOutcome) },
  });

  if (input.finalizedCandles < config.minimumFinalizedCandles) {
    return insufficient(`ต้องมีแท่งเทียน 1D ที่ปิดแล้วอย่างน้อย ${config.minimumFinalizedCandles} แท่ง แต่มี ${input.finalizedCandles} แท่ง`);
  }

  // --- Stage 1a: direction from the four opinion-bearing factors ----------
  const macroOutcome = input.macro.status === 'available'
    ? scoreMacro(input.macro.value)
    : { normalized: null, detail: input.macro.reason, partial: false, benchmarks: [] };
  const trendOutcome = input.trend.status === 'available'
    ? scoreTrend(input.trend.value)
    : { normalized: null, detail: input.trend.reason, partial: false };
  const momentumOutcome = input.momentum.status === 'available'
    ? scoreMomentum(input.momentum.value)
    : {
      normalized: null, detail: input.momentum.reason, partial: false,
      normalizedMomentum: null, normalizedMomentumCapped: false, confirmation: null,
      breakdown: {
        rawAtr: null, saturation: config.momentum.momentumAtrSaturation,
        clamped: null, afterSqueeze: null, multiplier: 1,
      },
    };
  const sentimentOutcome = input.sentiment.status === 'available'
    ? scoreSentiment(input.sentiment.value, { historyUnavailable: input.historyDegraded === true })
    : { normalized: null, detail: input.sentiment.reason, partial: false };

  const leadFactors = {
    macro: scoredFactor('macro', input.macro, macroOutcome),
    trend: scoredFactor('trend', input.trend, trendOutcome),
    momentum: scoredFactor('momentum', input.momentum, momentumOutcome),
    sentiment: scoredFactor('sentiment', input.sentiment, sentimentOutcome),
  };
  const leadEntries = Object.values(leadFactors);
  const leadWeight = leadEntries.reduce((sum, factor) => sum + (countsTowardWeight(factor) ? factor.maxPoints : 0), 0);
  const leadScore = leadEntries.reduce((sum, factor) => sum + (factor.points ?? 0), 0);
  const leadDirection = leadWeight > 0
    ? biasFromDirectionBalance(directionBalance(leadScore, leadWeight))
    : 'neutral';

  // --- Stage 1b: geometry, scored for the side that direction points at ---
  const riskRewardOutcome = input.riskReward.status === 'available'
    ? scoreRiskReward(input.riskReward.value, { direction: leadDirection })
    : {
      normalized: null, detail: input.riskReward.reason, partial: false, upsidePercent: null,
      downsidePercent: null, callRewardRisk: null, putRewardRisk: null, scoredSide: null,
      setupQuality: null, upsideAtr: null, downsideAtr: null,
      upsideExpectedMoves: null, downsideExpectedMoves: null, expectedMove: null,
      expectedMoveDte: null, expectedMoveHorizonWarning: null, reachability: 1,
    } satisfies RiskRewardOutcome;

  const factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore> = {
    ...leadFactors,
    riskReward: scoredFactor('riskReward', input.riskReward, riskRewardOutcome),
  };

  const entries = Object.values(factors);
  const missing = entries.filter((factor) => !factor.available).map((factor) => factor.id);
  const missingRequired = config.sufficiency.required.filter((id) => !factors[id].available);
  if (missingRequired.length) {
    return insufficient(`ขาดปัจจัยหลักที่ต้องมี: ${missingRequired.map((id) => FACTOR_LABELS[id]).join(', ')}`);
  }

  const availableWeight = entries.reduce((sum, factor) => sum + (countsTowardWeight(factor) ? factor.maxPoints : 0), 0);
  const summedPoints = entries.reduce((sum, factor) => sum + (factor.points ?? 0), 0);
  const absoluteScore = entries.reduce((sum, factor) => sum + Math.abs(factor.points ?? 0), 0);

  /*
   * --- The trend veto -----------------------------------------------------
   *
   * Two passes, and they cannot be collapsed into one: the veto asks whether the
   * trend opposes the direction, and the direction is not known until the points
   * have been summed. So the summed total names a PROVISIONAL bias, the veto is
   * measured against that, and the attenuated total is what everything published
   * is then computed from.
   *
   * The attenuation only ever shrinks the total toward zero, so the provisional
   * bias and the final bias can never disagree about SIDE — only about whether
   * there is enough left to call one at all. There is no second pass to run.
   */
  const provisionalBias = biasFromDirectionBalance(directionBalance(summedPoints, availableWeight));
  const trendOpposition = trendOppositionAgainst(factors.trend, provisionalBias);
  const vetoMultiplier = 1 - config.trendVeto.strength * trendOpposition;
  /*
   * Rounded to whole points, like every factor row it is a sum of.
   *
   * The multiplication is the only step in the model that can produce a
   * fraction of a point, and leaving it fractional put the published score and
   * the published FORMULA half a point apart — the formula printed its own raw
   * total rounded, then converted that, while the score converted the unrounded
   * one. On RKLB that read as "= 66" beside a 65. Rounding here is what makes
   * every printed number on the card the same number.
   *
   * `round` is sign-symmetric, so the put and call mirrors are unaffected.
   */
  const directionScore = round(summedPoints * vetoMultiplier, 0);
  const trendVetoApplied = trendOpposition > 0 && vetoMultiplier < 1;

  const directionScore0to100 = directionScoreOutOf100(directionScore, availableWeight);
  const scoreFormula = directionScoreFormula(
    directionScore,
    availableWeight,
    trendVetoApplied ? { pointsBefore: summedPoints, multiplier: vetoMultiplier } : null,
  );
  // Internal only. See `directionBalance`: the thresholds below are written on
  // this ruler and were not restated, so nothing about the gating changes here.
  const balance = directionBalance(directionScore, availableWeight);
  const underlyingBias = biasFromDirectionBalance(balance);

  // --- Stage 2: signal quality -------------------------------------------
  const coverage = availableWeight / OPTIONS_SIGNAL_TOTAL_WEIGHT;
  /*
   * "ความครบของข้อมูล", measured one level below the factors.
   *
   * `coverage` above answers "how much of the model's WEIGHT produced a score",
   * which is the right question for the PRIME floor and the wrong one for the
   * reader: every factor can produce a score while each one stands on less than
   * it needs, and the card then printed 100% beside a yellow "ข้อมูลบางส่วน"
   * badge, an unavailable IV Rank and two percentiles still counting down.
   *
   * This is the figure the reader is shown and the one the confidence coverage
   * term is computed from. The PRIME floor keeps reading `coverage`, because
   * that threshold was calibrated on that ruler and moving it would be a retune
   * smuggled in beside a bug fix.
   */
  const completeness = measureCompleteness(input, factors);
  /*
   * Agreement is measured on the SUMMED points, before the veto.
   *
   * The veto is a statement about the headline, not a new piece of evidence, and
   * running it through agreement would push it into confidence as well — where
   * `macro-trend-conflict` already deducts for this same disagreement. One
   * disagreement, two numbers, would be the double-count this change was
   * explicitly not meant to introduce.
   */
  const agreement = absoluteScore > 0 ? Math.abs(summedPoints) / absoluteScore : 0;
  /*
   * STRENGTH IS MEASURED AGAINST THE WHOLE MODEL, not against what happened to
   * be countable — because the divisor moves and the numerator does not.
   *
   * It used to be `absoluteScore / availableWeight`. When P0-2 struck the
   * unranked Options Sentiment out of the fraction, that divisor fell 90 -> 80
   * while the numerator stayed put (the factor was scoring zero), so the same
   * evidence reported 0.40 before and 0.45 after. LOSING A FACTOR MADE THE
   * EVIDENCE LOOK STRONGER, which no reading of the word can justify.
   *
   * On the reported card it happened to be masked: completeness fell far enough
   * in the same release to swallow it. That is luck, not a design — two terms
   * pulling opposite ways cancel at whatever ratio the inputs happen to have,
   * and on a card whose completeness fell less, confidence would have RISEN
   * because data went missing.
   *
   * Against the fixed total the numerator is the only thing that can move, so
   * the term is monotone by construction: an input that disappears can lower
   * this and can never raise it. Completeness still carries the "how much do we
   * know" question; this one now answers only "how hard is what we have
   * pushing", on a ruler that does not shrink to flatter the answer.
   */
  const evidenceStrength = clamp(absoluteScore / OPTIONS_SIGNAL_TOTAL_WEIGHT, 0, 1);

  const pricing = input.pricing.status === 'available' ? input.pricing.value : null;
  const ivLevel = pricing ? classifyIvLevel(pricing) : null;
  const daysToEarnings = input.event.status === 'available' ? finite(input.event.value.daysToEarnings) : null;
  /*
   * IS THE PREMIUM EXPENSIVE? — a question that cannot be asked across an
   * earnings report inside the contract.
   *
   * The reported card said "IV ÷ ความผันผวนจริง = 0.768 → ระดับความแพง: ต่ำ" two
   * sections above "งบประกาศ 27 ส.ค. อีก 5 วัน", a −15 confidence penalty for
   * exactly that, and an IV Crush warning. All four about one contract.
   *
   * The ratio is comparing two different periods: realized volatility is
   * BACKWARD-looking and describes shocks that have already happened, while the
   * implied volatility holds a risk that has not arrived yet. IV at this level
   * before a report is not cheap premium — it is the price OF the event, and
   * most of it disappears the morning after. Calling it "ต่ำ" invites a reader
   * to buy the one thing the same page is warning them about.
   *
   * The verdict is therefore WITHHELD, not recomputed: the engine has no
   * separation of event vol from base vol and inventing one here would be a
   * model change hidden inside a copy fix. What is published instead is that the
   * question cannot be answered, and why.
   *
   * `ivLevel` itself is untouched. The confidence penalties and the IV_WARNING
   * gate keep reading it, because those are scoring behaviour and this change is
   * not allowed to move any of it — a premium that is genuinely extreme still
   * gates, whether or not the card is willing to call it expensive.
   */
  const earningsInsideContract = daysToEarnings !== null
    && pricing?.dte != null
    && daysToEarnings >= 0
    && daysToEarnings <= pricing.dte;
  const ivLevelSuppression = earningsInsideContract
    ? `งบประกาศในอีก ${daysToEarnings} วัน ซึ่งอยู่ในอายุสัญญา ${pricing?.dte} วัน `
      + 'ค่า IV ส่วนหนึ่งจึงเป็นราคาของ event ที่จะหายไปหลังประกาศ ยังตัดสินความถูก/แพงไม่ได้'
    : null;

  const penalties: OptionsSignalPenalty[] = [];
  const penaltyConfig = config.confidence.penalties;
  if (daysToEarnings !== null) {
    if (daysToEarnings <= config.event.warningDays) {
      penalties.push({ id: 'earnings-imminent', amount: penaltyConfig.earningsImminent, detail: `ประกาศงบในอีก ${daysToEarnings} วัน` });
    } else if (daysToEarnings <= penaltyConfig.earningsNearDays) {
      penalties.push({ id: 'earnings-near', amount: penaltyConfig.earningsNear, detail: `ประกาศงบในอีก ${daysToEarnings} วัน` });
    } else if (daysToEarnings <= penaltyConfig.earningsApproachingDays) {
      penalties.push({ id: 'earnings-approaching', amount: penaltyConfig.earningsApproaching, detail: `ประกาศงบในอีก ${daysToEarnings} วัน` });
    }
  }
  if (ivLevel === 'extreme') {
    penalties.push({ id: 'iv-extreme', amount: penaltyConfig.ivExtreme, detail: 'ค่าพรีเมียมแพงผิดปกติ' });
  } else if (ivLevel === 'high') {
    penalties.push({ id: 'iv-high', amount: penaltyConfig.ivHigh, detail: 'ค่าพรีเมียมแพงกว่าปกติ' });
  }
  const macroPoints = factors.macro.points;
  const trendPoints = factors.trend.points;
  if (macroPoints !== null && trendPoints !== null && macroPoints !== 0 && trendPoints !== 0
    && Math.sign(macroPoints) !== Math.sign(trendPoints)) {
    penalties.push({ id: 'macro-trend-conflict', amount: penaltyConfig.macroTrendConflict, detail: 'ทิศทางตลาดรวมกับแนวโน้มหุ้นสวนกัน' });
  }
  const squeezeState = input.momentum.status === 'available' ? input.momentum.value.squeeze : null;
  if (squeezeState === 'ON') {
    penalties.push({ id: 'squeeze-on', amount: penaltyConfig.squeezeOn, detail: 'Squeeze ยังบีบตัว ยังไม่เลือกทาง' });
  }
  if (factors.momentum.partial) {
    penalties.push({ id: 'momentum-unconfirmed', amount: penaltyConfig.momentumUnconfirmed, detail: 'ไม่มี RVOL ยืนยันโมเมนตัม' });
  }
  const penaltyTotal = round(penalties.reduce((sum, penalty) => sum + penalty.amount, 0), 4);

  const confidenceBase = confidenceFromTerms({ coverage: completeness.value, agreement, strength: evidenceStrength });
  const confidenceScore = Math.round(clamp(confidenceBase - penaltyTotal, 0, 1) * 100);

  const primeBlockers: string[] = [];
  for (const id of config.sufficiency.primeRequired) {
    if (!factors[id].available) primeBlockers.push(`missing:${id}`);
  }
  if (coverage < config.sufficiency.primeMinimumCoverage) primeBlockers.push('coverage-below-floor');
  if (factors.momentum.partial) primeBlockers.push('momentum-unconfirmed');
  if (config.sufficiency.blockPrimeWhileSqueezeOn && squeezeState === 'ON') primeBlockers.push('squeeze-still-compressing');
  if (config.sufficiency.requirePricingForPrime && ivLevel === null) primeBlockers.push('iv-unavailable');
  if (Math.abs(balance) < config.quality.primeScore) primeBlockers.push('score-below-prime');
  if (confidenceScore < config.quality.primeConfidence) primeBlockers.push('confidence-below-prime');
  if (agreement < config.quality.primeAgreement) primeBlockers.push('agreement-below-prime');
  if (underlyingBias !== 'neutral' && trendPoints !== null
    && Math.sign(trendPoints) !== (underlyingBias === 'bullish' ? 1 : -1)) {
    primeBlockers.push('trend-opposes-bias');
  }
  const primeEligible = primeBlockers.length === 0 && underlyingBias !== 'neutral';

  /*
   * QUIET, or FIGHTING? — two states that were sharing one badge.
   *
   * A total near 50 arrives two ways. Every factor near zero is a flat tape and
   * the honest instruction is "there is nothing here". Trend -8 against Momentum
   * +9 cancelling to 51 is not that: something IS happening and the evidence
   * disagrees about what, which is strictly more dangerous than quiet — and the
   * card printed the identical grey SIDEWAYS badge for both.
   *
   * Measured on `agreement`, which is |summed| ÷ Σ|points| and already exists for
   * confidence. Reusing it means there is no second ruler that could disagree
   * with the first, and it is a dispersion measure by construction: it falls as
   * the factors cancel, whatever the total happens to be.
   *
   * The threshold alone is NOT enough. `agreement` is 0 by convention when there
   * are no points at all — the quiet case exactly — so a structural clause does
   * the rest: two measured factors have to be genuinely pointing opposite ways.
   * That clause is a fact about the evidence, not a second number to tune.
   */
  const opposedFactors = entries.filter((factor) => (
    countsTowardWeight(factor) && factor.points !== null && factor.points !== 0
  ));
  const evidenceIsFighting = opposedFactors.some((factor) => Math.sign(factor.points as number) > 0)
    && opposedFactors.some((factor) => Math.sign(factor.points as number) < 0)
    && agreement < config.quality.conflictedAgreement;

  let signalType: OptionsSignalType;
  if (underlyingBias === 'neutral' || Math.abs(balance) < config.quality.watchScore) {
    signalType = evidenceIsFighting ? 'CONFLICTED' : 'SIDEWAYS';
  } else if (primeEligible) {
    signalType = underlyingBias === 'bullish' ? 'PRIME_CALL' : 'PRIME_PUT';
  } else {
    signalType = underlyingBias === 'bullish' ? 'CALL_WATCH' : 'PUT_WATCH';
  }

  // --- Stage 3: risk gate -------------------------------------------------
  const ivWarningReasons: string[] = [];
  if (ivLevel === 'extreme') ivWarningReasons.push('ค่าพรีเมียมของ option แพงผิดปกติ (IV สูงมาก)');
  if (daysToEarnings !== null && daysToEarnings <= config.event.warningDays) {
    ivWarningReasons.push(`ประกาศงบในอีก ${daysToEarnings} วัน ความผันผวนจะยุบตัวหลังประกาศ`);
  }
  const downgrades: string[] = [];
  if (ivWarningReasons.length) {
    signalType = 'IV_WARNING';
  } else {
    const isPrime = signalType === 'PRIME_CALL' || signalType === 'PRIME_PUT';
    if (isPrime && daysToEarnings !== null && daysToEarnings <= config.event.blockPrimeDays) {
      downgrades.push('earnings-blocks-prime');
      signalType = signalType === 'PRIME_CALL' ? 'CALL_WATCH' : 'PUT_WATCH';
    } else if (isPrime && ivLevel === 'high') {
      downgrades.push('high-iv-blocks-prime');
      signalType = signalType === 'PRIME_CALL' ? 'CALL_WATCH' : 'PUT_WATCH';
    }
  }

  const diagnostics: OptionsSignalDiagnostics = {
    factors,
    rawDirectionPoints: round(directionScore, 0),
    /*
     * The veto, stated whether or not it fired. A block that only appears when
     * a score was pressed down is a block a reader cannot use to tell "the trend
     * agreed" from "nobody checked".
     */
    trendVeto: {
      applied: trendVetoApplied,
      opposition: round(trendOpposition, 3),
      multiplier: round(vetoMultiplier, 3),
      pointsBeforeVeto: round(summedPoints, 0),
    },
    availableWeight,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    directionScore0to100,
    scoreFormula,
    directionBalance: balance,
    directionScaleFormula: directionScaleFormula(directionScore, availableWeight),
    coverage: round(coverage, 4),
    completeness: { ...completeness, value: round(completeness.value, 4) },
    agreement: round(agreement, 4),
    evidenceStrength: round(evidenceStrength, 4),
    confidenceBase: round(confidenceBase, 4),
    confidenceFormula: confidenceFormulaText(
      { coverage: completeness.value, agreement, strength: evidenceStrength },
      config.confidence,
      penaltyTotal,
    ),
    penalties,
    penaltyTotal,
    dataSufficiency: {
      passed: true,
      missing,
      primeEligible,
      primeBlockers,
    },
    riskReward: {
      price: input.riskReward.status === 'available' ? roundOrNull(input.riskReward.value.price, 4) : null,
      support: input.riskReward.status === 'available' ? roundOrNull(input.riskReward.value.support, 4) : null,
      resistance: input.riskReward.status === 'available' ? roundOrNull(input.riskReward.value.resistance, 4) : null,
      upsidePercent: roundOrNull(riskRewardOutcome.upsidePercent, 2),
      downsidePercent: roundOrNull(riskRewardOutcome.downsidePercent, 2),
      callRewardRisk: roundOrNull(riskRewardOutcome.callRewardRisk, 2),
      putRewardRisk: roundOrNull(riskRewardOutcome.putRewardRisk, 2),
      scoredSide: riskRewardOutcome.scoredSide,
      setupQuality: roundOrNull(riskRewardOutcome.setupQuality, 4),
      upsideAtr: roundOrNull(riskRewardOutcome.upsideAtr, 2),
      downsideAtr: roundOrNull(riskRewardOutcome.downsideAtr, 2),
      upsideExpectedMoves: roundOrNull(riskRewardOutcome.upsideExpectedMoves, 2),
      downsideExpectedMoves: roundOrNull(riskRewardOutcome.downsideExpectedMoves, 2),
      expectedMove: roundOrNull(riskRewardOutcome.expectedMove, 4),
      expectedMoveDte: riskRewardOutcome.expectedMoveDte,
      expectedMoveHorizonWarning: riskRewardOutcome.expectedMoveHorizonWarning,
      reachability: round(riskRewardOutcome.reachability, 3),
      state: input.riskReward.state,
    },
    iv: {
      // Withheld across an earnings report inside the contract. See above: the
      // gate still reads the unsuppressed level, only the VERDICT is withheld.
      level: ivLevelSuppression === null ? ivLevel : null,
      levelSuppressedReason: ivLevelSuppression,
      basis: pricing?.basis ?? null,
      ivRank: pricing?.basis === 'iv-rank' ? roundOrNull(pricing.ivRank, 1) : null,
      ivPercentile: pricing?.basis === 'iv-percentile' ? roundOrNull(pricing.ivPercentile, 1) : null,
      // A countdown and an outage are different sentences. When the store is
      // unreachable the countdown is withheld, because it would not be counting.
      percentilePending: input.historyDegraded === true ? null : input.ivPercentilePending ?? null,
      percentileStoreUnavailable: input.historyDegraded === true,
      impliedVolatility: roundOrNull(pricing?.impliedVolatility, 6),
      realizedVolatility: pricing?.basis === 'iv-vs-realized' ? roundOrNull(pricing.realizedVolatility, 4) : null,
      realizedWindowDays: pricing?.basis === 'iv-vs-realized' ? pricing.realizedWindowDays : null,
      dte: pricing?.dte ?? null,
      ratio: pricing?.basis === 'iv-vs-realized' ? roundOrNull(pricing.ratio, 3) : null,
      observations: pricing?.observations ?? null,
      state: input.pricing.state,
      reason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      source: input.pricing.provider,
      fetchedAt: input.pricing.asOf,
    },
    liquidity: liquidityDiagnostics(input.liquidity, liquidityOutcome),
    event: {
      reportDate: input.event.status === 'available' ? input.event.value.reportDate : null,
      daysToEarnings,
      timeOfDay: input.event.status === 'available' ? input.event.value.timeOfDay : null,
      state: input.event.state,
      reason: input.event.status === 'unavailable' ? input.event.reason : null,
      source: input.event.provider,
      fetchedAt: input.event.asOf,
    },
    squeeze: {
      state: squeezeState,
      momentum: input.momentum.status === 'available' ? roundOrNull(input.momentum.value.squeezeMomentum, 4) : null,
      normalizedMomentum: roundOrNull(momentumOutcome.normalizedMomentum, 3),
      normalizedMomentumCapped: momentumOutcome.normalizedMomentumCapped,
      relativeVolume: input.momentum.status === 'available' ? roundOrNull(input.momentum.value.relativeVolume, 4) : null,
      confirmationFormula: rvolConfirmationFormula(
        input.momentum.status === 'available' ? input.momentum.value.relativeVolume : null,
      ),
      confirmation: roundOrNull(momentumOutcome.confirmation, 4),
      breakdown: {
        rawAtr: roundOrNull(momentumOutcome.breakdown.rawAtr, 3),
        saturation: momentumOutcome.breakdown.saturation,
        clamped: roundOrNull(momentumOutcome.breakdown.clamped, 3),
        afterSqueeze: roundOrNull(momentumOutcome.breakdown.afterSqueeze, 3),
        multiplier: round(momentumOutcome.breakdown.multiplier, 3),
      },
    },
    macro: { benchmarks: macroOutcome.benchmarks ?? [] },
    provenance,
    gates: { ivWarning: ivWarningReasons.length > 0, ivWarningReasons, downgrades },
  };

  return {
    ...base,
    status: 'available',
    signalType,
    directionScore0to100,
    confidenceScore,
    underlyingBias,
    liquidityGrade: liquidityOutcome?.grade ?? null,
    reasoning: buildReasoning({
      factors,
      signalType,
      underlyingBias,
      // The reason list is user-facing prose, so it gets the WITHHELD verdict —
      // "ค่าพรีเมียมของ option ยังไม่แพง" is the same claim as the badge.
      ivLevel: ivLevelSuppression === null ? ivLevel : null,
      ivLevelSuppressedReason: ivLevelSuppression,
      ivWarningReasons,
      downgrades,
      penalties,
      daysToEarnings,
      pricingReason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      percentilePending: input.ivPercentilePending ?? null,
      historyDegraded: input.historyDegraded === true,
      trendVeto: { applied: trendVetoApplied, multiplier: vetoMultiplier },
      liquidity: liquidityOutcome,
      expectedMoveHorizonWarning: riskRewardOutcome.expectedMoveHorizonWarning,
      staleMix: provenance.staleMix,
      spreadHours: provenance.spreadHours,
      spreadSessions: provenance.spreadSessions,
    }),
    suggestedOptionsSetup: buildSetup(
      signalType,
      underlyingBias,
      ivLevel,
      input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      daysToEarnings,
      liquidityOutcome,
      ivLevelSuppression,
    ),
    diagnostics,
  };
}

function buildReasoning(context: {
  factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore>;
  signalType: OptionsSignalType;
  underlyingBias: UnderlyingBias;
  ivLevel: IvLevel | null;
  /** Set when the verdict was withheld; printed in place of a ถูก/แพง sentence. */
  ivLevelSuppressedReason: string | null;
  ivWarningReasons: string[];
  downgrades: string[];
  penalties: OptionsSignalPenalty[];
  daysToEarnings: number | null;
  pricingReason: string | null;
  percentilePending: OptionsSignalInput['ivPercentilePending'];
  historyDegraded: boolean;
  trendVeto: { applied: boolean; multiplier: number } | null;
  liquidity: LiquidityOutcome | null;
  expectedMoveHorizonWarning: string | null;
  staleMix: boolean;
  spreadHours: number | null;
  spreadSessions: number | null;
}): OptionsSignalReason[] {
  const reasons: OptionsSignalReason[] = [];
  const supportive = context.underlyingBias === 'bullish' ? 1 : context.underlyingBias === 'bearish' ? -1 : 0;

  for (const factor of Object.values(context.factors)) {
    /*
     * A factor struck from the divisor says so here too. "ไม่มีข้อมูล" would be
     * the wrong sentence for Options Sentiment holding a real Put/Call it simply
     * cannot rank, and the reason list is where a reader looks to find out why a
     * factor they can see on the card contributed nothing.
     */
    if (factor.measurement === 'fallback-neutral') {
      reasons.push({
        id: `${factor.id}-not-counted`,
        polarity: 'information',
        text: `${FACTOR_LABELS[factor.id]}: ไม่นับรวมในคะแนน (${factor.fallbackReason}) · ${factor.detail}`,
      });
      continue;
    }
    if (!factor.available || factor.points === null) {
      reasons.push({ id: `${factor.id}-unavailable`, polarity: 'information', text: `${FACTOR_LABELS[factor.id]}: ${factor.detail}` });
      continue;
    }
    const polarity = factor.points === 0
      ? 'information'
      : supportive !== 0 && Math.sign(factor.points) === supportive
        ? 'positive'
        : supportive !== 0 ? 'negative' : 'information';
    reasons.push({ id: factor.id, polarity, text: `${FACTOR_LABELS[factor.id]}: ${factor.detail}` });
  }

  if (context.ivLevel) {
    const text = context.ivLevel === 'low'
      ? 'ค่าพรีเมียมของ option ยังไม่แพง'
      : context.ivLevel === 'normal'
        ? 'ค่าพรีเมียมของ option อยู่ระดับปกติ'
        : context.ivLevel === 'high'
          ? 'ค่าพรีเมียมของ option แพงกว่าปกติ'
          : 'ค่าพรีเมียมของ option แพงผิดปกติ';
    reasons.push({
      id: 'iv-level',
      polarity: context.ivLevel === 'low' || context.ivLevel === 'normal' ? 'information' : 'caution',
      text,
    });
  } else if (context.ivLevelSuppressedReason) {
    reasons.push({
      id: 'iv-level-pre-earnings',
      polarity: 'caution',
      text: `ยังตัดสินความถูก/แพงของค่าพรีเมียมไม่ได้ · ${context.ivLevelSuppressedReason}`,
    });
  } else if (context.pricingReason) {
    reasons.push({ id: 'iv-unavailable', polarity: 'information', text: `Implied Volatility: ${context.pricingReason}` });
  }

  /*
   * Two different sentences, and mixing them is the failure this distinction
   * exists to prevent. "Needs N more days" is a schedule; a store that cannot be
   * read is not counting down to anything, and a countdown shown for it would
   * never move.
   */
  if (context.historyDegraded) {
    reasons.push({
      id: 'history-unavailable',
      polarity: 'caution',
      text: 'อ่านประวัติการอ่านค่าย้อนหลังของหุ้นตัวนี้ไม่สำเร็จ IV Percentile และ Put/Call Percentile จึงใช้ไม่ได้ชั่วคราว (ไม่ใช่เพราะข้อมูลยังไม่พอ) ระหว่างนี้ใช้เกณฑ์เทียบความผันผวนจริงแทน',
    });
  } else if (context.percentilePending && context.percentilePending.missingDays > 0) {
    reasons.push({
      id: 'iv-percentile-pending',
      polarity: 'information',
      text: `IV Percentile ต้องการข้อมูลอีก ${context.percentilePending.missingDays} วัน (มีแล้ว ${context.percentilePending.observations}/${context.percentilePending.required} วัน) จึงยังใช้เกณฑ์เทียบความผันผวนจริงไปก่อน`,
    });
  }

  if (context.trendVeto?.applied) {
    reasons.push({
      id: 'trend-veto',
      polarity: 'caution',
      text: `แนวโน้มของหุ้น (${FACTOR_LABELS.trend}) สวนกับทิศทางที่ปัจจัยอื่นรวมกันชี้ `
        + `จึงลดคะแนนทิศทางลงเหลือ ${Math.round(context.trendVeto.multiplier * 100)}% `
        + 'ก่อนตัดสินป้ายกำกับ ไม่ได้ตัดทิ้งและไม่ได้กลับข้าง',
    });
  }

  if (context.liquidity?.grade) {
    reasons.push({
      id: 'liquidity',
      polarity: context.liquidity.grade === 'thin' ? 'caution' : 'information',
      text: `สภาพคล่องของ chain: ${context.liquidity.detail}`,
    });
  }

  if (context.expectedMoveHorizonWarning) {
    reasons.push({
      id: 'expected-move-horizon',
      polarity: 'caution',
      text: context.expectedMoveHorizonWarning,
    });
  }

  if (context.staleMix) {
    reasons.push({
      id: 'stale-mix',
      polarity: 'caution',
      /*
       * Sessions, not hours. Hours is what put this sentence on every weekend
       * card for a set of sources that were all looking at the same Friday.
       */
      text: context.spreadSessions === null
        ? `แหล่งข้อมูลของสัญญาณนี้ต่างเวลากันถึง ${context.spreadHours ?? 0} ชั่วโมง จึงยึดเวลาที่เก่าที่สุดเป็นเวลาของสัญญาณ`
        : `แหล่งข้อมูลของสัญญาณนี้มาจากคนละเซสชันเทรดกัน ห่างกัน ${context.spreadSessions} เซสชัน จึงยึดเวลาที่เก่าที่สุดเป็นเวลาของสัญญาณ`,
    });
  }

  for (const warning of context.ivWarningReasons) {
    reasons.push({ id: `gate-${warning.slice(0, 12)}`, polarity: 'caution', text: warning });
  }
  if (context.downgrades.includes('earnings-blocks-prime')) {
    reasons.push({ id: 'downgrade-earnings', polarity: 'caution', text: 'ลดระดับจาก PRIME เพราะใกล้วันประกาศงบ' });
  }
  if (context.downgrades.includes('high-iv-blocks-prime')) {
    reasons.push({ id: 'downgrade-iv', polarity: 'caution', text: 'ลดระดับจาก PRIME เพราะค่าพรีเมียมแพงกว่าปกติ' });
  }
  reasons.push(DISCLAIMER_REASON);
  return reasons;
}
