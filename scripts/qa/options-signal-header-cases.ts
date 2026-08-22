/**
 * Fixtures for the Options Signal card header probe.
 *
 * They are DTOs rather than engine output on purpose: the header prints two
 * numbers and two words, and what this probe is about is where those four boxes
 * land, not how the numbers were arrived at. Building them here keeps the probe
 * offline, and it makes the extreme pairings — a three-digit score beside a
 * one-digit confidence — something a person can write down rather than
 * something a market has to happen to produce.
 */
import { confidenceFormulaText, rvolConfirmationFormula } from '@/src/lib/analytics/options-signal/calculations';
import type { OptionsSignalDto } from '@/src/lib/analytics/options-signal/dto';
import type {
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
  OptionsSignalType,
} from '@/src/lib/analytics/options-signal/types';

const AS_OF = '2026-08-19T20:00:00.000Z';

function factor(
  id: OptionsSignalFactorId,
  points: number,
  maxPoints: number,
  detail: string,
): OptionsSignalFactorScore {
  return {
    id,
    points,
    maxPoints,
    normalized: points / maxPoints,
    state: 'DELAYED',
    available: true,
    measurement: 'measured',
    fallbackReason: null,
    partial: false,
    detail,
    reason: null,
    provider: 'fixture-market-data',
    asOf: AS_OF,
  };
}

function signalOf(options: {
  signalType: OptionsSignalType;
  directionScore0to100: number;
  confidenceScore: number;
  breakdown: boolean;
}): OptionsSignalDto {
  const summary: OptionsSignalDto['summary'] = {
    symbol: 'RKLB',
    timeframe: '1D',
    calculatedAt: '2026-08-19T00:00:00.000Z',
    latestCandleAt: '2026-08-18',
    finalizedCandles: 250,
    status: 'available',
    signalType: options.signalType,
    directionScore0to100: options.directionScore0to100,
    scoreFormula: `(+26 + 100) ÷ (2 × 100) × 100 = ${options.directionScore0to100}`,
    confidenceScore: options.confidenceScore,
    underlyingBias: options.signalType === 'SIDEWAYS' ? 'neutral' : 'bullish',
    asOf: AS_OF,
    staleMix: false,
    liquidityGrade: 'good',
    configVersion: '2026.08.19b',
    historyDegraded: false,
    reason: null,
  };

  if (!options.breakdown) return { summary, breakdown: null };

  return {
    summary,
    breakdown: {
      reasoning: [
        { id: 'trend-up', polarity: 'positive', text: 'ราคายืนเหนือ EMA20 และ EMA50' },
        { id: 'earnings', polarity: 'caution', text: 'อีก 8 วันมี Earnings' },
      ],
      suggestedOptionsSetup: {
        status: 'suggested',
        direction: 'call',
        dteMin: 30,
        dteMax: 60,
        deltaMin: 0.35,
        deltaMax: 0.5,
        rationale: 'ใช้ Call เมื่อแนวโน้มและโมเมนตัมยืนยันกัน',
        warnings: ['จำกัดความเสี่ยงต่อสถานะ'],
      },
      diagnostics: {
        trendVeto: { applied: false, opposition: 0, multiplier: 1, pointsBeforeVeto: 0 },
        factors: {
          macro: factor('macro', 12, 20, 'SPY และ QQQ อยู่เหนือ EMA20'),
          trend: factor('trend', 18, 25, 'ราคาอยู่เหนือ EMA20 และ EMA50'),
          momentum: factor('momentum', 14, 20, 'Squeeze fired bullish พร้อม RVOL'),
          sentiment: factor('sentiment', 8, 15, 'Put/Call OI = 0.72'),
          riskReward: factor('riskReward', 12, 20, 'Call R:R = 2.4'),
        },
        rawDirectionPoints: 26,
        availableWeight: 100,
        totalWeight: 100,
        directionScore0to100: options.directionScore0to100,
        scoreFormula: `(+26 + 100) ÷ (2 × 100) × 100 = ${options.directionScore0to100}`,
        coverage: 1,
        completeness: {
          value: 0.74,
          inputs: [
            { id: 'trend.ema50', group: 'trend', label: 'EMA50 ของหุ้น', available: true, counted: true, note: null },
            { id: 'pricing.own-baseline', group: 'pricing', label: 'ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)', available: false, counted: false, note: 'ขาดอีก 59 วัน' },
          ],
          missing: ['ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)'],
          notCounted: [],
        },
        agreement: 0.86,
        evidenceStrength: 0.8,
        confidenceBase: options.confidenceScore / 100,
        confidenceFormula: confidenceFormulaText({ coverage: 1, agreement: 1, strength: options.confidenceScore / 100 }),
        penalties: [],
        penaltyTotal: 0,
        dataSufficiency: {
          passed: true,
          missing: [],
          primeEligible: false,
          primeBlockers: ['CONFIDENCE_BELOW_PRIME'],
        },
        riskReward: {
          reachability: 1,
          price: 42.59,
          support: 39.27,
          resistance: 46.41,
          upsidePercent: 8.97,
          downsidePercent: 7.8,
          callRewardRisk: 1.15,
          putRewardRisk: 0.87,
          scoredSide: 'call',
          setupQuality: 0.62,
          upsideAtr: 1.9,
          downsideAtr: 1.65,
          upsideExpectedMoves: 0.71,
          downsideExpectedMoves: 0.62,
          expectedMove: 5.36,
          expectedMoveDte: 44,
          expectedMoveHorizonWarning: null,
          state: 'DELAYED',
        },
        iv: {
          level: 'normal',
      levelSuppressedReason: null,
          basis: 'iv-vs-realized',
          ivRank: null,
          ivPercentile: null,
          percentilePending: { observations: 12, required: 60, missingDays: 48 },
          percentileStoreUnavailable: false,
          impliedVolatility: 0.681,
          realizedVolatility: 0.63,
          realizedWindowDays: 30,
          dte: 44,
          ratio: 1.08,
          observations: 250,
          state: 'DELAYED',
          reason: null,
          source: 'fixture-options',
          fetchedAt: AS_OF,
        },
        event: {
          reportDate: '2026-08-27',
          daysToEarnings: 8,
          timeOfDay: 'post-market',
          state: 'DELAYED',
          reason: null,
          source: 'fixture-earnings',
          fetchedAt: AS_OF,
        },
        liquidity: {
          grade: 'good',
          score: 88,
          medianOpenInterest: 2_400,
          medianVolume: 310,
          medianSpreadPercent: 2.4,
          contractsExamined: 14,
          expiration: '2026-09-19',
          marketOpenAtCapture: true,
          offHoursAssessment: null,
      closedSpreadWarning: null,
          state: 'DELAYED',
          reason: null,
          detail: 'OI กลาง 2,400 · Volume กลาง 310',
        },
        squeeze: {
          breakdown: { rawAtr: 2.4, saturation: 3.5, clamped: 0.686, afterSqueeze: 0.686, multiplier: 0.98 },
          state: 'FIRED_BULLISH',
          momentum: 2.4,
          normalizedMomentum: 0.686,
          normalizedMomentumCapped: false,
          relativeVolume: 1.8,
          confirmation: 0.8,
      confirmationFormula: rvolConfirmationFormula(1.06),
        },
        macro: {
          benchmarks: [
            { symbol: 'SPY', close: 500, ema20: 480, aboveEma20: true },
            { symbol: 'QQQ', close: 400, ema20: 390, aboveEma20: true },
          ],
        },
        provenance: {
          asOf: AS_OF,
          newestAsOf: '2026-08-19T22:00:00.000Z',
          spreadHours: 2,
          spreadSessions: 0,
          staleMix: false,
          sources: [
            { id: 'trend', provider: 'fixture-market-data', asOf: AS_OF, fetchedAt: null },
            { id: 'pricing', provider: 'fixture-options', asOf: '2026-08-19T22:00:00.000Z', fetchedAt: '2026-08-19T22:05:00.000Z' },
          ],
        },
        gates: { ivWarning: false, ivWarningReasons: [], downgrades: [] },
      },
    },
  };
}

export interface HeaderCase {
  name: string;
  signal: OptionsSignalDto;
  breakdownEntitled: boolean;
}

/**
 * The header at the shapes it actually takes.
 *
 * The digit counts are the point of the last three: each value run is centred
 * under its own label, so the widest-against-narrowest pairing is where a
 * centring bug shows, and a three-digit score beside a one-digit confidence is
 * the widest that pairing gets.
 */
export const CASES: HeaderCase[] = [
  {
    name: 'call-watch-two-digit',
    signal: signalOf({ signalType: 'CALL_WATCH', directionScore0to100: 63, confidenceScore: 60, breakdown: true }),
    breakdownEntitled: true,
  },
  {
    name: 'sideways-two-digit',
    signal: signalOf({ signalType: 'SIDEWAYS', directionScore0to100: 52, confidenceScore: 41, breakdown: true }),
    breakdownEntitled: true,
  },
  {
    name: 'prime-call-three-vs-one',
    signal: signalOf({ signalType: 'PRIME_CALL', directionScore0to100: 100, confidenceScore: 8, breakdown: true }),
    breakdownEntitled: true,
  },
  {
    name: 'iv-warning-one-vs-three',
    signal: signalOf({ signalType: 'IV_WARNING', directionScore0to100: 7, confidenceScore: 100, breakdown: true }),
    breakdownEntitled: true,
  },
  {
    name: 'pro-locked-breakdown',
    signal: signalOf({ signalType: 'PUT_WATCH', directionScore0to100: 38, confidenceScore: 55, breakdown: false }),
    breakdownEntitled: false,
  },
];
