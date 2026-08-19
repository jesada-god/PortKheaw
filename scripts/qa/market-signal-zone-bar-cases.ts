/**
 * The zone bar's QA fixtures, in a module both halves of the QA can import.
 *
 * The harness renders these on the server (`market-signal-zone-bar-mobile-qa`)
 * and then hydrates the same cards in the browser
 * (`market-signal-zone-bar-client`), because the bar's caption arrangement is
 * decided from MEASURED boxes and there is nothing to measure until React is
 * running on the page. Both halves have to be looking at the same fixtures or
 * hydration is comparing two different cards, so the fixtures live here rather
 * than in either of them.
 */
import type { MarketSignalResult, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';

export interface ZoneBarCase {
  name: string;
  result: MarketSignalResult;
  livePrice: number | null;
  /** The live price is in a different field from the close, so the two marks
      have to read as two marks at every width and in both appearances. */
  markersApart?: boolean;
}

const base: MarketSignalResult = {
  status: 'available',
  symbol: 'IREN',
  state: 'BULLISH',
  bias: 'bullish',
  score: 34,
  confidence: 62,
  confidenceLabel: 'Medium',
  evidenceAgreement: 62,
  evidenceAgreementLabel: 'Medium',
  timeframe: '1D',
  calculatedAt: '2026-08-18T00:00:00.000Z',
  latestCandleAt: '2026-08-14',
  source: 'yahoo-finance-chart',
  freshness: { status: 'end-of-day', asOf: '2026-08-14T20:00:00.000Z', maxAgeSeconds: 21_600 },
  dataPoints: { received: 260, finalized: 259 },
  scoreBreakdown: {
    emaTrend: { points: 12, maxPoints: 30, normalizedScore: 0.4, coverage: 1, factorsUsed: 4, available: true },
    momentum: { points: 8, maxPoints: 25, normalizedScore: 0.32, coverage: 1, factorsUsed: 3, available: true },
    trendStrength: { points: 4, maxPoints: 15, normalizedScore: 0.27, coverage: 1, factorsUsed: 1, available: true },
    volume: { points: 3, maxPoints: 15, normalizedScore: 0.2, coverage: 1, factorsUsed: 2, available: true },
    priceStructure: { points: 7, maxPoints: 15, normalizedScore: 0.47, coverage: 1, factorsUsed: 2, available: true },
  },
  reasons: [{ id: 'ema-structure', polarity: 'positive', text: 'ราคาและ EMA เรียงตัวเอนขึ้น', impact: 8 }],
  warnings: [],
  flags: ['conflicting_evidence', 'low_volume_confirmation', 'weak_confirmation', 'squeeze', 'strong_momentum'],
  metrics: {
    close: 44.06, ema20: 42, ema50: 40, ema200: 33,
    ema20SlopePct: 1.2, ema50SlopePct: 0.8, ema200SlopePct: 0.3, emaCompressionRatio: 0.04,
    rsi14: 62, macd: 2.1, macdSignal: 1.8, macdHistogram: 0.3,
    adx14: 24, plusDi14: 31, minusDi14: 18, relativeVolume20: 1.4, obvTrend: 'rising',
    bollingerUpper: 48, bollingerMiddle: 44, bollingerLower: 40,
    keltnerUpper: 49, keltnerMiddle: 44, keltnerLower: 39,
    squeezeOn: false, atr14: 4.06, ema20DeviationPct: 3.42, atrNormalizedDistance: 1.71,
    nearestSupport: 39.27, nearestResistance: 46.23, divergence: null,
  },
  confidenceBreakdown: {
    completeness: 85, agreement: 62, evidenceStrength: 34,
    volumeConfirmation: 20, regimeClarity: 100, conflictPenalty: 5,
  },
};

const zones: MarketSignalZones = {
  mode: 'structural',
  zone: 'sideways',
  support: 39.2727,
  resistance: 46.2297,
  upperTrigger: 47.244,
  lowerTrigger: 38.2583,
  positionPct: 68.8,
  upperDistance: 3.184,
  upperDistanceAtr: 0.78,
  lowerDistance: 5.8017,
  lowerDistanceAtr: 1.43,
  frameAgeBars: 12,
  proximity: 'near_trigger',
  nearestTriggerAtr: 0.78,
  zoneAgeBars: 9,
  lastTestedBarsAgo: 0,
  triggerCrossings: 14,
  pendingBreakout: false,
  pendingBreakdown: false,
  entry: null,
  referenceClose: 44.06,
  referenceDate: '2026-08-14',
};

/**
 * The cases, chosen so every branch that positions something lands in at least
 * one of them: marker in the middle, marker jammed against each end, a live
 * price beside the close, a live price that IS the close, a five-digit
 * instrument, and the fully loaded card.
 */
export const CASES: ZoneBarCase[] = [
  {
    name: 'sideways-mid-frame',
    result: { ...base, state: 'SIDEWAYS', bias: 'neutral', score: 16, zones },
    livePrice: null,
  },
  {
    name: 'live-price-crossed-up',
    result: { ...base, zones: { ...zones, zone: 'uptrend' } },
    livePrice: 47.9,
    markersApart: true,
  },
  {
    name: 'close-pinned-to-the-low-end',
    result: {
      ...base,
      state: 'BEARISH',
      bias: 'bearish',
      score: -42,
      zones: { ...zones, zone: 'downtrend', referenceClose: 30.11, lowerDistance: -8.15, upperDistance: 17.13, zoneAgeBars: 1 },
    },
    livePrice: 29.4,
  },
  {
    name: 'close-pinned-to-the-high-end',
    result: {
      ...base,
      zones: { ...zones, zone: 'uptrend', referenceClose: 61.42, upperDistance: -14.18, lowerDistance: 23.16, frameAgeBars: 2 },
    },
    livePrice: 62.05,
  },
  {
    name: 'five-figure-instrument-with-actionable',
    result: {
      ...base,
      symbol: 'BTC-USD',
      zones: {
        ...zones,
        zone: 'uptrend',
        support: 104_233.41, resistance: 118_902.77,
        lowerTrigger: 103_192.08, upperTrigger: 120_091.68,
        referenceClose: 121_884.35,
        upperDistance: -1792.67, lowerDistance: 18_692.27,
        entry: { level: 118_902.77, height: 14_669.36, mode: 'structural', barsAgo: 1 },
      },
      actionable: {
        invalidation: 118_902.77, invalidationAtr: 0.45, invalidationPct: 2.45, invalidationBasis: 'zone_floor',
        target: 133_572.13, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 3.94, notes: ['risk_leg_inside_noise'],
      },
    },
    livePrice: 122_401.9,
  },
  /*
   * IREN, 2026-08-18 — the case the bar was rebuilt for.
   *
   * Upper trigger 43.25, close 44.06, live 42.38: the headline reads BULLISH
   * off a close above the frame while the price on screen has already fallen
   * back inside it. One marker in a green field is a reader concluding the move
   * is still on, so both marks have to be drawn, both have to be visible in
   * both appearances, and they have to be far enough apart to read as two.
   */
  {
    name: 'live-price-back-inside-the-frame',
    result: {
      ...base,
      zones: {
        ...zones,
        zone: 'uptrend',
        upperTrigger: 43.25,
        lowerTrigger: 38.2583,
        referenceClose: 44.06,
        upperDistance: -0.81,
        upperDistanceAtr: -0.2,
        lowerDistance: 5.8017,
        nearestTriggerAtr: -0.2,
        positionPct: 116.2,
      },
      actionable: {
        invalidation: 43.25, invalidationAtr: 0.2, invalidationPct: 1.84, invalidationBasis: 'zone_floor',
        target: 48.24, targetAtr: 1.23, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 5.16, notes: ['risk_leg_inside_noise'],
      },
    },
    livePrice: 42.38,
    markersApart: true,
  },
  /*
   * The case that has to be IMPOSSIBLE to pass by accident.
   *
   * Close 44.06, live 43.70, upper trigger 43.90: the live price is 0.82% from
   * the close and 0.46% from the trigger, which is the arrangement that put
   * three numbers into one row on the bar it replaced. On a phone nothing here
   * is far enough from anything else for the layout to place each caption on its
   * own mark, so this is where the merge fires — and where, if it stops firing,
   * the overlap check has to be the thing that says so. Reverting the merge and
   * re-running is the falsification: it reports `labels-overlap` on this case at
   * the three phone widths, in both appearances.
   *
   * At 1280 the same two prices are 23px apart once each caption has been grown
   * away from its neighbour, and the bar keeps two captions. That is the point
   * of measuring rather than thresholding: it is the same code, the same two
   * prices, and two different amounts of room.
   */
  {
    name: 'live-price-jammed-against-the-trigger',
    result: {
      ...base,
      zones: {
        ...zones,
        zone: 'uptrend',
        upperTrigger: 43.9,
        lowerTrigger: 38.2583,
        referenceClose: 44.06,
        upperDistance: -0.16,
        upperDistanceAtr: -0.04,
        lowerDistance: 5.8017,
        nearestTriggerAtr: -0.04,
        positionPct: 103.2,
      },
    },
    livePrice: 43.7,
    markersApart: true,
  },
  /*
   * ONE PRICE, TWO NAMES FOR IT.
   *
   * Close 42.00, live 42.00: the two marks land on the same percent and paint
   * as one line, and the bar was captioning that single line "ปิดล่าสุด 42 ·
   * ราคาตอนนี้ 42" — two identical numbers presented as two facts, over one
   * mark, with a sentence underneath repeating the second of them in full. The
   * spread/merge machinery cannot catch it because nothing about it is a
   * collision: there is all the room in the world at 1440px and the captions
   * still say the same thing twice.
   *
   * `markersApart` is deliberately absent: these two marks are meant to be one
   * line, which is exactly why one caption is the honest count.
   */
  {
    name: 'live-price-equals-the-close',
    result: {
      ...base,
      state: 'SIDEWAYS',
      bias: 'neutral',
      score: 16,
      zones: { ...zones, zone: 'sideways', referenceClose: 42, upperDistance: 5.244, lowerDistance: 3.7417 },
    },
    livePrice: 42,
  },
  {
    name: 'actionable-with-every-row',
    result: {
      ...base,
      zones: { ...zones, zone: 'uptrend', entry: { level: 43.72, height: 14.79, mode: 'structural', barsAgo: 1 } },
      actionable: {
        invalidation: 42.24, invalidationAtr: 0.45, invalidationPct: 4.13, invalidationBasis: 'zone_floor',
        target: 58.51, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 7.94, notes: [],
      },
    },
    livePrice: 44.58,
  },
];
