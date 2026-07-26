export const MARKET_SIGNAL_SCORE_WEIGHTS = {
  emaTrend: 30,
  momentum: 25,
  trendStrength: 15,
  volume: 15,
  priceStructure: 15,
} as const;

export const MARKET_SIGNAL_THRESHOLDS = {
  minimumSignalCandles: 50,
  minimumAvailableWeight: 50,
  directional: {
    strongBullish: 60,
    bullish: 20,
    bearish: -20,
    strongBearish: -60,
  },
  ema: {
    shortSlopeLookback: 5,
    mediumSlopeLookback: 10,
    longSlopeLookback: 20,
    strongSlopeRatio: 0.01,
    sidewaysSlopeRatio: 0.003,
    sidewaysCompressionRatio: 0.03,
  },
  momentum: {
    rsiBullishExtreme: 75,
    rsiBearishExtreme: 25,
    rsiSidewaysMinimum: 45,
    rsiSidewaysMaximum: 55,
    macdAtrScale: 0.2,
    histogramFlatAtrRatio: 0.05,
  },
  trendStrength: {
    adxSidewaysMaximum: 20,
    adxTrendMinimum: 25,
    adxStrong: 40,
  },
  volume: {
    relativeVolumeBaseline: 1,
    relativeVolumeConfirmation: 1.2,
    relativeVolumeHigh: 1.5,
    directionLookback: 5,
    obvSlopeLookback: 10,
  },
  structure: {
    pivotWindow: 3,
    breakoutBufferRatio: 0.001,
  },
  squeeze: {
    keltnerPeriod: 20,
    keltnerAtrPeriod: 14,
    keltnerAtrMultiplier: 1.5,
  },
  overextended: {
    ema20DeviationPct: 8,
    atrDistance: 3,
    evidenceRequired: 2,
  },
  divergence: {
    minimumPivotSeparation: 3,
    rsiMinimumDifference: 2,
    macdAtrMinimumDifference: 0.02,
  },
  sideways: {
    evidenceRequired: 4,
    minimumAvailableEvidence: 4,
  },
  confidence: {
    completenessWeight: 0.3,
    agreementWeight: 0.25,
    strengthWeight: 0.2,
    volumeWeight: 0.1,
    regimeClarityWeight: 0.15,
    conflictPenaltyWeight: 0.25,
    mediumMinimum: 60,
    highMinimum: 80,
  },
} as const;

export const MARKET_SIGNAL_EXPECTED_FACTORS = {
  emaTrend: 4,
  momentum: 3,
  trendStrength: 1,
  volume: 2,
  priceStructure: 2,
} as const;

export const MARKET_SIGNAL_TOTAL_WEIGHT = Object.values(MARKET_SIGNAL_SCORE_WEIGHTS)
  .reduce((sum, weight) => sum + weight, 0);
