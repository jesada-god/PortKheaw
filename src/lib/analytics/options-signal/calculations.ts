import {
  OPTIONS_SIGNAL_CONFIG,
  OPTIONS_SIGNAL_CONFIG_VERSION,
  OPTIONS_SIGNAL_TOTAL_WEIGHT,
  OPTIONS_SIGNAL_WEIGHTS,
} from './config';
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

const percent = (value: number) => `${value > 0 ? '+' : ''}${round(value, 2)}%`;

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

export function scoreMomentum(
  input: MomentumInput,
  config = OPTIONS_SIGNAL_CONFIG.momentum,
): MomentumOutcome {
  const squeezeMomentum = finite(input.squeezeMomentum);
  const atr = finite(input.atr);
  const rawNormalized = squeezeMomentum !== null && atr !== null && atr > 0
    ? squeezeMomentum / (atr * config.momentumAtrSaturation)
    : null;
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

  return {
    normalized: clamp(base * multiplier, -1, 1),
    detail: `${squeezeText} · ${volumeText}`,
    partial: relativeVolume === null,
    normalizedMomentum,
    normalizedMomentumCapped,
    confirmation,
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
  const expectedMoveHorizonWarning = beyond.length === 0
    ? null
    : `${beyond.join(' และ ')} · สัญญาที่ใช้อ้างอิงเหลืออายุ ${expectedMoveDte ?? '—'} วัน `
      + 'ราคาจึงมีโอกาสน้อยที่จะไปถึงก่อนหมดอายุ และ R:R ที่วัดจากระยะนี้จะดูดีเกินจริง';

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

  const distanceText = [
    upside === null ? null : `ขึ้นถึงแนวต้าน ${percent(upside)}${geometry.upsideAtr === null ? '' : ` (${round(geometry.upsideAtr, 2)} ATR)`}`,
    downside === null ? null : `ลงถึงแนวรับ ${percent(-downside)}${geometry.downsideAtr === null ? '' : ` (${round(geometry.downsideAtr, 2)} ATR)`}`,
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
    };
  }
  if (downside === null) {
    return {
      ...geometry,
      normalized: -1,
      detail: `ไม่พบแนวรับใต้ราคา · ความเสี่ยงฝั่งลงเปิดกว้าง · ${distanceText}`,
      scoredSide: 'put',
      setupQuality: 1,
    };
  }
  if (upside === 0 && downside === 0) {
    return { ...geometry, normalized: 0, detail: 'ราคาติดทั้งแนวรับและแนวต้าน', scoredSide: null, setupQuality: 0 };
  }
  if (downside === 0) {
    return {
      ...geometry,
      normalized: 1,
      detail: `ราคาอยู่ที่แนวรับ ระยะถึงแนวต้าน ${percent(upside)}`,
      scoredSide: 'call',
      setupQuality: 1,
    };
  }
  if (upside === 0) {
    return {
      ...geometry,
      normalized: -1,
      detail: `ราคาอยู่ที่แนวต้าน ระยะถึงแนวรับ ${percent(downside)}`,
      scoredSide: 'put',
      setupQuality: 1,
    };
  }

  const callQuality = setupQualityOf(callRewardRisk, config.saturationRatio);
  const putQuality = setupQualityOf(putRewardRisk, config.saturationRatio);
  const bestRatio = Math.max(callRewardRisk ?? 0, putRewardRisk ?? 0);
  const bestQuality = Math.max(callQuality ?? 0, putQuality ?? 0);
  const ratioText = `R:R Call ${round(callRewardRisk as number, 2)} · R:R Put ${round(putRewardRisk as number, 2)}`;
  const expectedMoveText = geometry.upsideExpectedMoves === null || geometry.downsideExpectedMoves === null
    ? ''
    : ` · เทียบ Expected Move (${expectedMoveDte ?? '—'} วัน): ขึ้น ${round(geometry.upsideExpectedMoves, 2)}× `
      + `ลง ${round(geometry.downsideExpectedMoves, 2)}×`;

  /*
   * The signed tilt of the geometry, on the call frame of reference.
   *
   * `log(rr) / log(base)` is symmetric by construction — `log(1/x) = -log(x)` —
   * so the put frame below is the exact mirror of this one, and widening the
   * base makes both ends harder to reach by the same amount.
   */
  const tilt = clamp(Math.log((callRewardRisk as number)) / Math.log(config.tiltSaturationRatio), -1, 1);

  if (direction === 'bullish') {
    return {
      ...geometry,
      normalized: tilt,
      scoredSide: 'call',
      setupQuality: callQuality,
      detail: `หลักฐานอื่นชี้ขาขึ้น จึงวัดจากฝั่ง Call · ${distanceText} · ${ratioText}${expectedMoveText}`,
    };
  }
  if (direction === 'bearish') {
    // Mirror image: a strong PUT reward:risk is strong evidence for the bearish
    // thesis, and carries the same magnitude a strong call R:R would carry up.
    const putTilt = clamp(Math.log((putRewardRisk as number)) / Math.log(config.tiltSaturationRatio), -1, 1);
    return {
      ...geometry,
      normalized: -putTilt,
      scoredSide: 'put',
      setupQuality: putQuality,
      detail: `หลักฐานอื่นชี้ขาลง จึงวัดจากฝั่ง Put · ${distanceText} · ${ratioText}${expectedMoveText}`,
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
  return {
    ...geometry,
    normalized: tilt * config.sidewaysDamping,
    scoredSide: null,
    setupQuality: bestQuality,
    detail: `${distanceText} · ${ratioText} · ${qualityText}${expectedMoveText}`,
  };
}

// ---------------------------------------------------------------------------
// Liquidity — a tradeability badge. Never a direction, never a weight.
// ---------------------------------------------------------------------------

export interface LiquidityOutcome {
  grade: LiquidityGrade | null;
  score: number | null;
  detail: string;
  /** OI and volume only, with the spread excluded. Present when the book was shut. */
  offHoursAssessment: { grade: Exclude<LiquidityGrade, 'unknown'>; score: number } | null;
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
    };
  }

  if (marketOpen === false) {
    const standingOnly = compose(standing);
    return {
      grade: 'unknown',
      score: null,
      detail: `${measured} · ${context} · เก็บข้อมูลตอนตลาดปิด ส่วนต่าง Bid/Ask นอกเวลาทำการกว้างผิดปกติเป็นปกติ `
        + 'จึงยังประเมินสภาพคล่องไม่ได้'
        + (standingOnly === null
          ? ''
          : ` · ถ้าดูเฉพาะ OI และ Volume: ${liquidityVerdict(standingOnly.grade)}`),
      offHoursAssessment: standingOnly,
    };
  }

  const composed = compose(spreadScore === null ? standing : [...standing, spreadScore]);
  if (composed === null) {
    return {
      grade: null,
      score: null,
      detail: 'ไม่มีข้อมูล Open Interest, Volume หรือ Bid/Ask พอจะประเมินสภาพคล่อง',
      offHoursAssessment: null,
    };
  }
  return {
    grade: composed.grade,
    score: composed.score,
    detail: `${measured} · ${context} · ${liquidityVerdict(composed.grade)}`,
    offHoursAssessment: null,
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

/** The same conversion, written out for the reader. */
export function directionScoreFormula(rawScore: number, maximumAbsolute: number): string {
  const raw = round(finite(rawScore) ?? 0, 0);
  const maxAbs = round(finite(maximumAbsolute) ?? 0, 0);
  const signed = `${raw > 0 ? '+' : ''}${raw}`;
  return `(${signed} + ${maxAbs}) ÷ (2 × ${maxAbs}) × 100 = ${directionScoreOutOf100(raw, maxAbs)}`;
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
      usable: entry.slot.status === 'available' && Number.isFinite(Date.parse(entry.slot.asOf ?? '')),
    }));

  const stamps = sources
    .filter((source) => source.usable && source.asOf !== null)
    .map((source) => ({ asOf: source.asOf as string, ms: Date.parse(source.asOf as string) }))
    .sort((left, right) => left.ms - right.ms);

  const published = sources.map(({ id, provider, asOf }) => ({ id, provider, asOf }));
  if (!stamps.length) {
    return { asOf: null, newestAsOf: null, spreadHours: null, staleMix: false, sources: published };
  }
  const oldest = stamps[0];
  const newest = stamps[stamps.length - 1];
  const spreadHours = stamps.length > 1 ? round((newest.ms - oldest.ms) / HOUR_MS, 2) : null;
  return {
    asOf: oldest.asOf,
    newestAsOf: newest.asOf,
    spreadHours,
    staleMix: spreadHours !== null && spreadHours > config.staleMixHours,
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
  return {
    id,
    points: round(normalized * maxPoints, 0),
    maxPoints,
    normalized: round(normalized, 4),
    state: slot.state,
    available: true,
    partial: outcome.partial,
    detail: outcome.detail,
    reason: null,
    provider: slot.provider,
    asOf: slot.asOf,
  };
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
): SuggestedOptionsSetup {
  const warnings = setupWarnings(daysToEarnings, liquidity);
  if (signalType === 'IV_WARNING') {
    return { status: 'not-recommended', reason: 'อยู่ในสถานะเตือนความเสี่ยง (IV สูงมาก หรือใกล้ประกาศงบ) จึงยังไม่เสนอรูปแบบสัญญา', warnings };
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
    rationale: ivLevel === 'low'
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
      marketOpenAtCapture: null, offHoursAssessment: null,
      state: 'UNAVAILABLE', reason: 'ยังไม่ได้โหลด options chain จึงยังประเมินสภาพคล่องไม่ได้',
      detail: 'ยังไม่ได้โหลด options chain จึงยังประเมินสภาพคล่องไม่ได้',
    };
  }
  if (slot.status === 'unavailable' || !outcome) {
    const reason = slot.status === 'unavailable' ? slot.reason : 'ประเมินสภาพคล่องไม่ได้';
    return {
      grade: null, score: null, medianOpenInterest: null, medianVolume: null,
      medianSpreadPercent: null, contractsExamined: null, expiration: null,
      marketOpenAtCapture: null, offHoursAssessment: null,
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
    availableWeight: 0,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    directionScore0to100: 50,
    scoreFormula: 'ไม่มีปัจจัยที่มีข้อมูลพอจะแปลงเป็นคะแนน',
    coverage: 0,
    agreement: 0,
    evidenceStrength: 0,
    confidenceBase: 0,
    penalties: [],
    penaltyTotal: 0,
    dataSufficiency: { passed: false, missing: [], primeEligible: false, primeBlockers: ['data-insufficient'] },
    riskReward: {
      price: null, support: null, resistance: null, upsidePercent: null,
      downsidePercent: null, callRewardRisk: null, putRewardRisk: null,
      scoredSide: null, setupQuality: null, upsideAtr: null, downsideAtr: null,
      upsideExpectedMoves: null, downsideExpectedMoves: null, expectedMove: null,
      expectedMoveDte: null, expectedMoveHorizonWarning: null,
      state: input.riskReward.state,
    },
    iv: {
      level: null, basis: null, ivRank: null, ivPercentile: null,
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
  const leadWeight = leadEntries.reduce((sum, factor) => sum + (factor.available ? factor.maxPoints : 0), 0);
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
      expectedMoveDte: null, expectedMoveHorizonWarning: null,
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

  const availableWeight = entries.reduce((sum, factor) => sum + (factor.available ? factor.maxPoints : 0), 0);
  const directionScore = entries.reduce((sum, factor) => sum + (factor.points ?? 0), 0);
  const absoluteScore = entries.reduce((sum, factor) => sum + Math.abs(factor.points ?? 0), 0);
  const directionScore0to100 = directionScoreOutOf100(directionScore, availableWeight);
  const scoreFormula = directionScoreFormula(directionScore, availableWeight);
  // Internal only. See `directionBalance`: the thresholds below are written on
  // this ruler and were not restated, so nothing about the gating changes here.
  const balance = directionBalance(directionScore, availableWeight);
  const underlyingBias = biasFromDirectionBalance(balance);

  // --- Stage 2: signal quality -------------------------------------------
  const coverage = availableWeight / OPTIONS_SIGNAL_TOTAL_WEIGHT;
  const agreement = absoluteScore > 0 ? Math.abs(directionScore) / absoluteScore : 0;
  const evidenceStrength = availableWeight > 0 ? clamp(absoluteScore / availableWeight, 0, 1) : 0;

  const pricing = input.pricing.status === 'available' ? input.pricing.value : null;
  const ivLevel = pricing ? classifyIvLevel(pricing) : null;
  const daysToEarnings = input.event.status === 'available' ? finite(input.event.value.daysToEarnings) : null;

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

  const confidenceBase = confidenceFromTerms({ coverage, agreement, strength: evidenceStrength });
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

  let signalType: OptionsSignalType;
  if (underlyingBias === 'neutral' || Math.abs(balance) < config.quality.watchScore) {
    signalType = 'SIDEWAYS';
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
    availableWeight,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    directionScore0to100,
    scoreFormula,
    coverage: round(coverage, 4),
    agreement: round(agreement, 4),
    evidenceStrength: round(evidenceStrength, 4),
    confidenceBase: round(confidenceBase, 4),
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
      state: input.riskReward.state,
    },
    iv: {
      level: ivLevel,
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
      dte: pricing?.basis === 'iv-vs-realized' ? pricing.dte : null,
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
      confirmation: roundOrNull(momentumOutcome.confirmation, 4),
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
      ivLevel,
      ivWarningReasons,
      downgrades,
      penalties,
      daysToEarnings,
      pricingReason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      percentilePending: input.ivPercentilePending ?? null,
      historyDegraded: input.historyDegraded === true,
      liquidity: liquidityOutcome,
      expectedMoveHorizonWarning: riskRewardOutcome.expectedMoveHorizonWarning,
      staleMix: provenance.staleMix,
      spreadHours: provenance.spreadHours,
    }),
    suggestedOptionsSetup: buildSetup(
      signalType,
      underlyingBias,
      ivLevel,
      input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      daysToEarnings,
      liquidityOutcome,
    ),
    diagnostics,
  };
}

function buildReasoning(context: {
  factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore>;
  signalType: OptionsSignalType;
  underlyingBias: UnderlyingBias;
  ivLevel: IvLevel | null;
  ivWarningReasons: string[];
  downgrades: string[];
  penalties: OptionsSignalPenalty[];
  daysToEarnings: number | null;
  pricingReason: string | null;
  percentilePending: OptionsSignalInput['ivPercentilePending'];
  historyDegraded: boolean;
  liquidity: LiquidityOutcome | null;
  expectedMoveHorizonWarning: string | null;
  staleMix: boolean;
  spreadHours: number | null;
}): OptionsSignalReason[] {
  const reasons: OptionsSignalReason[] = [];
  const supportive = context.underlyingBias === 'bullish' ? 1 : context.underlyingBias === 'bearish' ? -1 : 0;

  for (const factor of Object.values(context.factors)) {
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
      text: `แหล่งข้อมูลของสัญญาณนี้ต่างเวลากันถึง ${context.spreadHours ?? 0} ชั่วโมง จึงยึดเวลาที่เก่าที่สุดเป็นเวลาของสัญญาณ`,
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
