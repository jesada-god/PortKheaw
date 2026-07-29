import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_TOTAL_WEIGHT, OPTIONS_SIGNAL_WEIGHTS } from './config';
import type {
  IvLevel,
  IvPricingInput,
  MacroInput,
  MomentumInput,
  OptionsSignalDiagnostics,
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  OptionsSignalPenalty,
  OptionsSignalProvenance,
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
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const percent = (value: number) => `${value > 0 ? '+' : ''}${round(value, 2)}%`;

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
    ema20: benchmark.ema20,
    aboveEma20: benchmark.ema20 === null ? null : benchmark.close > benchmark.ema20,
  }));
  const usable = benchmarks.filter((benchmark) => benchmark.ema20 !== null);
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
  const votes: number[] = [];
  if (input.ema20 !== null) votes.push(Math.sign(input.close - input.ema20));
  if (input.ema50 !== null) votes.push(Math.sign(input.close - input.ema50));
  if (input.ema20 !== null && input.ema50 !== null) votes.push(Math.sign(input.ema20 - input.ema50));
  if (!votes.length) {
    return { normalized: null, detail: 'คำนวณ EMA20/EMA50 จากแท่งที่ปิดแล้วไม่ได้', partial: false };
  }
  const normalized = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  const detail = normalized > 0
    ? 'ราคายืนเหนือเส้นค่าเฉลี่ยและ EMA เรียงตัวขาขึ้น'
    : normalized < 0
      ? 'ราคาอยู่ใต้เส้นค่าเฉลี่ยและ EMA เรียงตัวขาลง'
      : 'ราคากับเส้นค่าเฉลี่ยยังพันกัน ไม่มีทิศทางชัด';
  return { normalized, detail, partial: input.ema50 === null };
}

export interface MomentumOutcome extends FactorOutcome {
  normalizedMomentum: number | null;
  confirmation: number | null;
}

export function scoreMomentum(
  input: MomentumInput,
  config = OPTIONS_SIGNAL_CONFIG.momentum,
): MomentumOutcome {
  const normalizedMomentum = input.squeezeMomentum !== null && input.atr !== null && input.atr > 0
    ? clamp(input.squeezeMomentum / (input.atr * config.momentumAtrSaturation), -1, 1)
    : null;

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
      confirmation: null,
    };
  }

  // Relative volume describes ACTIVITY, so it can only scale a direction that
  // already exists — it can never create or flip one.
  const confirmation = input.relativeVolume === null
    ? null
    : clamp(
      (input.relativeVolume - config.rvolFloor) / (config.rvolSaturation - config.rvolFloor),
      0,
      1,
    );
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
  const volumeText = input.relativeVolume === null
    ? 'ไม่มีข้อมูล RVOL ยืนยัน'
    : `RVOL ${round(input.relativeVolume, 2)}×`;

  return {
    normalized: clamp(base * multiplier, -1, 1),
    detail: `${squeezeText} · ${volumeText}`,
    partial: input.relativeVolume === null,
    normalizedMomentum,
    confirmation,
  };
}

export function scoreSentiment(
  input: SentimentInput,
  config = OPTIONS_SIGNAL_CONFIG.sentiment,
): FactorOutcome {
  const ratio = input.putCallRatio;
  let normalized = 0;
  if (ratio <= config.bullishBelow) {
    normalized = clamp((config.bullishBelow - ratio) / (config.bullishBelow - config.bullishSaturation), 0, 1);
  } else if (ratio >= config.bearishAbove) {
    normalized = -clamp((ratio - config.bearishAbove) / (config.bearishSaturation - config.bearishAbove), 0, 1);
  }
  const detail = normalized > 0
    ? `Put/Call OI ${round(ratio, 2)} · ฝั่ง Call ถือครองมากกว่า`
    : normalized < 0
      ? `Put/Call OI ${round(ratio, 2)} · ฝั่ง Put ถือครองมากกว่า`
      : `Put/Call OI ${round(ratio, 2)} · อยู่ในโซนปกติ`;
  return { normalized, detail, partial: false };
}

export interface RiskRewardOutcome extends FactorOutcome {
  upsidePercent: number | null;
  downsidePercent: number | null;
  callRewardRisk: number | null;
  putRewardRisk: number | null;
}

export function scoreRiskReward(
  input: RiskRewardInput,
  config = OPTIONS_SIGNAL_CONFIG.riskReward,
): RiskRewardOutcome {
  const empty: RiskRewardOutcome = {
    normalized: null,
    detail: 'ไม่มีแนวรับหรือแนวต้านที่ยืนยันได้',
    partial: false,
    upsidePercent: null,
    downsidePercent: null,
    callRewardRisk: null,
    putRewardRisk: null,
  };
  if (!Number.isFinite(input.price) || input.price <= 0) return empty;
  if (input.support === null && input.resistance === null) return empty;

  const rawUpside = input.resistance === null ? null : (input.resistance - input.price) / input.price * 100;
  const rawDownside = input.support === null ? null : (input.price - input.support) / input.price * 100;
  // A level the price is already sitting on is a touch, not a target.
  const upside = rawUpside === null ? null : Math.max(0, rawUpside < config.minimumDistancePercent ? 0 : rawUpside);
  const downside = rawDownside === null ? null : Math.max(0, rawDownside < config.minimumDistancePercent ? 0 : rawDownside);

  const callRewardRisk = upside !== null && downside !== null && downside > 0 ? upside / downside : null;
  const putRewardRisk = upside !== null && downside !== null && upside > 0 ? downside / upside : null;

  let normalized: number;
  let detail: string;
  // A missing level on one side is unbounded on THAT side: no confirmed
  // resistance overhead is clear runway up, and no confirmed support beneath is
  // open downside. The two cases are exact mirrors of each other.
  if (upside === null) {
    normalized = 1;
    detail = `ไม่พบแนวต้านเหนือราคา (ราคาอยู่บริเวณจุดสูงสุด) · ห่างแนวรับ ${percent(downside ?? 0)}`;
  } else if (downside === null) {
    normalized = -1;
    detail = `ไม่พบแนวรับใต้ราคา · ความเสี่ยงฝั่งลงเปิดกว้าง แม้ห่างแนวต้าน ${percent(upside)}`;
  } else if (upside === 0 && downside === 0) {
    normalized = 0;
    detail = 'ราคาติดทั้งแนวรับและแนวต้าน';
  } else if (downside === 0) {
    normalized = 1;
    detail = `ราคาอยู่ที่แนวรับ ระยะถึงแนวต้าน ${percent(upside)}`;
  } else if (upside === 0) {
    normalized = -1;
    detail = `ราคาอยู่ที่แนวต้าน ระยะถึงแนวรับ ${percent(downside)}`;
  } else {
    normalized = clamp(
      Math.log(upside / downside) / Math.log(config.saturationRatio),
      -1,
      1,
    );
    detail = `ขึ้นถึงแนวต้าน ${percent(upside)} · ลงถึงแนวรับ ${percent(downside)} · R:R ฝั่ง Call ${round(upside / downside, 2)}`;
  }

  return {
    normalized,
    detail,
    partial: upside === null || downside === null,
    upsidePercent: upside,
    downsidePercent: downside,
    callRewardRisk,
    putRewardRisk,
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
  if (pricing.ratio >= config.realized.extremeFrom) return 'extreme';
  if (pricing.ratio > config.realized.highAbove) return 'high';
  if (pricing.ratio >= config.realized.normalFrom) return 'normal';
  return 'low';
}

export function biasFromNormalizedScore(
  normalizedScore: number,
  config = OPTIONS_SIGNAL_CONFIG.direction,
): UnderlyingBias {
  if (normalizedScore >= config.bullish) return 'bullish';
  if (normalizedScore <= config.bearish) return 'bearish';
  return 'neutral';
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
  if (outcome.normalized === null) return unavailableFactor(id, slot, outcome.detail);
  const maxPoints = OPTIONS_SIGNAL_WEIGHTS[id];
  return {
    id,
    points: round(outcome.normalized * maxPoints, 0),
    maxPoints,
    normalized: round(outcome.normalized, 4),
    state: slot.state,
    available: true,
    partial: outcome.partial,
    detail: outcome.detail,
    reason: null,
    provider: slot.provider,
    asOf: slot.asOf,
  };
}

function setupWarnings(daysToEarnings: number | null): string[] {
  return daysToEarnings === null
    ? [...SETUP_WARNINGS, 'ยังไม่ทราบวันประกาศงบ ให้ตรวจสอบปฏิทินของบริษัทเองก่อนเปิดสถานะ']
    : [...SETUP_WARNINGS, `วันประกาศงบครั้งถัดไปอีก ${daysToEarnings} วัน`];
}

function buildSetup(
  signalType: OptionsSignalType,
  bias: UnderlyingBias,
  ivLevel: IvLevel | null,
  ivReason: string | null,
  daysToEarnings: number | null,
): SuggestedOptionsSetup {
  const warnings = setupWarnings(daysToEarnings);
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
    directionScore: 0,
    availableWeight: 0,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    normalizedScore: 0,
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
      state: input.riskReward.state,
    },
    iv: {
      level: null, basis: null, ivRank: null, impliedVolatility: null, realizedVolatility: null,
      ratio: null, observations: null, state: input.pricing.state,
      reason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      source: input.pricing.provider, fetchedAt: input.pricing.asOf,
    },
    event: {
      reportDate: null, daysToEarnings: null, timeOfDay: null, state: input.event.state,
      reason: input.event.status === 'unavailable' ? input.event.reason : null,
      source: input.event.provider, fetchedAt: input.event.asOf,
    },
    squeeze: { state: null, momentum: null, normalizedMomentum: null, relativeVolume: null, confirmation: null },
    macro: { benchmarks: [] },
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
 *  1. **Direction** — only the five weighted directional factors.
 *  2. **Signal quality** — how much of that direction is actually evidenced.
 *  3. **Risk gate** — implied volatility and event risk, which can veto or
 *     downgrade a signal but can never create one.
 */
export function calculateOptionsSignal(input: OptionsSignalInput): OptionsSignalResult {
  const config = OPTIONS_SIGNAL_CONFIG;
  const base = {
    symbol: input.symbol,
    timeframe: input.timeframe,
    calculatedAt: input.calculatedAt,
    latestCandleAt: input.latestCandleAt,
    finalizedCandles: input.finalizedCandles,
  };

  const insufficient = (reason: string): OptionsSignalResult => ({
    ...base,
    status: 'insufficient-data',
    signalType: null,
    confidenceScore: 0,
    underlyingBias: null,
    reason,
    reasoning: [{ id: 'insufficient-data', polarity: 'caution', text: reason }, DISCLAIMER_REASON],
    suggestedOptionsSetup: {
      status: 'not-recommended',
      reason: 'ข้อมูลไม่พอสำหรับประเมินทิศทาง จึงไม่เสนอรูปแบบสัญญา',
      warnings: setupWarnings(input.event.status === 'available' ? input.event.value.daysToEarnings : null),
    },
    diagnostics: emptyDiagnostics(input),
  });

  if (input.finalizedCandles < config.minimumFinalizedCandles) {
    return insufficient(`ต้องมีแท่งเทียน 1D ที่ปิดแล้วอย่างน้อย ${config.minimumFinalizedCandles} แท่ง แต่มี ${input.finalizedCandles} แท่ง`);
  }

  // --- Stage 1: direction -------------------------------------------------
  const macroOutcome = input.macro.status === 'available'
    ? scoreMacro(input.macro.value)
    : { normalized: null, detail: input.macro.reason, partial: false, benchmarks: [] };
  const trendOutcome = input.trend.status === 'available'
    ? scoreTrend(input.trend.value)
    : { normalized: null, detail: input.trend.reason, partial: false };
  const momentumOutcome = input.momentum.status === 'available'
    ? scoreMomentum(input.momentum.value)
    : { normalized: null, detail: input.momentum.reason, partial: false, normalizedMomentum: null, confirmation: null };
  const sentimentOutcome = input.sentiment.status === 'available'
    ? scoreSentiment(input.sentiment.value)
    : { normalized: null, detail: input.sentiment.reason, partial: false };
  const riskRewardOutcome = input.riskReward.status === 'available'
    ? scoreRiskReward(input.riskReward.value)
    : {
      normalized: null, detail: input.riskReward.reason, partial: false, upsidePercent: null,
      downsidePercent: null, callRewardRisk: null, putRewardRisk: null,
    };

  const factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore> = {
    macro: scoredFactor('macro', input.macro, macroOutcome),
    trend: scoredFactor('trend', input.trend, trendOutcome),
    momentum: scoredFactor('momentum', input.momentum, momentumOutcome),
    sentiment: scoredFactor('sentiment', input.sentiment, sentimentOutcome),
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
  const normalizedScore = availableWeight > 0
    ? round(clamp(directionScore / availableWeight * 100, -100, 100), 0)
    : 0;
  const underlyingBias = biasFromNormalizedScore(normalizedScore);

  // --- Stage 2: signal quality -------------------------------------------
  const coverage = availableWeight / OPTIONS_SIGNAL_TOTAL_WEIGHT;
  const agreement = absoluteScore > 0 ? Math.abs(directionScore) / absoluteScore : 0;
  const evidenceStrength = availableWeight > 0 ? clamp(absoluteScore / availableWeight, 0, 1) : 0;

  const pricing = input.pricing.status === 'available' ? input.pricing.value : null;
  const ivLevel = pricing ? classifyIvLevel(pricing) : null;
  const daysToEarnings = input.event.status === 'available' ? input.event.value.daysToEarnings : null;

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

  const confidenceBase = config.confidence.coverageWeight * coverage
    + config.confidence.agreementWeight * agreement
    + config.confidence.strengthWeight * evidenceStrength;
  const confidenceScore = Math.round(clamp(confidenceBase - penaltyTotal, 0, 1) * 100);

  const primeBlockers: string[] = [];
  for (const id of config.sufficiency.primeRequired) {
    if (!factors[id].available) primeBlockers.push(`missing:${id}`);
  }
  if (coverage < config.sufficiency.primeMinimumCoverage) primeBlockers.push('coverage-below-floor');
  if (factors.momentum.partial) primeBlockers.push('momentum-unconfirmed');
  if (config.sufficiency.blockPrimeWhileSqueezeOn && squeezeState === 'ON') primeBlockers.push('squeeze-still-compressing');
  if (config.sufficiency.requirePricingForPrime && ivLevel === null) primeBlockers.push('iv-unavailable');
  if (Math.abs(normalizedScore) < config.quality.primeScore) primeBlockers.push('score-below-prime');
  if (confidenceScore < config.quality.primeConfidence) primeBlockers.push('confidence-below-prime');
  if (agreement < config.quality.primeAgreement) primeBlockers.push('agreement-below-prime');
  if (underlyingBias !== 'neutral' && trendPoints !== null
    && Math.sign(trendPoints) !== (underlyingBias === 'bullish' ? 1 : -1)) {
    primeBlockers.push('trend-opposes-bias');
  }
  const primeEligible = primeBlockers.length === 0 && underlyingBias !== 'neutral';

  let signalType: OptionsSignalType;
  if (underlyingBias === 'neutral' || Math.abs(normalizedScore) < config.quality.watchScore) {
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
    directionScore: round(directionScore, 0),
    availableWeight,
    totalWeight: OPTIONS_SIGNAL_TOTAL_WEIGHT,
    normalizedScore,
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
      price: input.riskReward.status === 'available' ? input.riskReward.value.price : null,
      support: input.riskReward.status === 'available' ? input.riskReward.value.support : null,
      resistance: input.riskReward.status === 'available' ? input.riskReward.value.resistance : null,
      upsidePercent: riskRewardOutcome.upsidePercent,
      downsidePercent: riskRewardOutcome.downsidePercent,
      callRewardRisk: riskRewardOutcome.callRewardRisk === null ? null : round(riskRewardOutcome.callRewardRisk, 2),
      putRewardRisk: riskRewardOutcome.putRewardRisk === null ? null : round(riskRewardOutcome.putRewardRisk, 2),
      state: input.riskReward.state,
    },
    iv: {
      level: ivLevel,
      basis: pricing?.basis ?? null,
      ivRank: pricing?.basis === 'iv-rank' ? round(pricing.ivRank, 1) : null,
      impliedVolatility: pricing?.impliedVolatility ?? null,
      realizedVolatility: pricing?.basis === 'iv-vs-realized' ? round(pricing.realizedVolatility, 4) : null,
      ratio: pricing?.basis === 'iv-vs-realized' ? round(pricing.ratio, 3) : null,
      observations: pricing?.observations ?? null,
      state: input.pricing.state,
      reason: input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      source: input.pricing.provider,
      fetchedAt: input.pricing.asOf,
    },
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
      momentum: input.momentum.status === 'available' ? input.momentum.value.squeezeMomentum : null,
      normalizedMomentum: momentumOutcome.normalizedMomentum === null ? null : round(momentumOutcome.normalizedMomentum, 4),
      relativeVolume: input.momentum.status === 'available' ? input.momentum.value.relativeVolume : null,
      confirmation: momentumOutcome.confirmation === null ? null : round(momentumOutcome.confirmation, 4),
    },
    macro: { benchmarks: macroOutcome.benchmarks ?? [] },
    gates: { ivWarning: ivWarningReasons.length > 0, ivWarningReasons, downgrades },
  };

  return {
    ...base,
    status: 'available',
    signalType,
    confidenceScore,
    underlyingBias,
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
    }),
    suggestedOptionsSetup: buildSetup(
      signalType,
      underlyingBias,
      ivLevel,
      input.pricing.status === 'unavailable' ? input.pricing.reason : null,
      daysToEarnings,
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
