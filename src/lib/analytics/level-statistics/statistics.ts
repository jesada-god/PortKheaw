/**
 * Touch / Hold / Break statistics for a support or resistance level.
 *
 * Every number here is measured against the canonical OHLCV the chart is already
 * displaying — nothing is fetched, estimated or generated. The engine is a pure
 * function of its inputs, so the same dataset always produces the same counts.
 *
 * Methodology (deterministic, no look-ahead):
 *  - Tolerance around a level is `ATR(period) × multiple` taken from the *same*
 *    Wilder ATR the rest of the analytics use, evaluated at the interaction bar.
 *  - A **touch** is a bar whose [low, high] intersects the tolerance band. While
 *    price stays inside the band the run is one interaction: consecutive candles
 *    testing the same zone never double count. A new touch needs both the
 *    cooldown to elapse *and* price to have left the band in between.
 *  - A **break** needs a confirmed *close* beyond the band (below for support,
 *    above for resistance) within the validation window — a wick through the
 *    level is never a break.
 *  - A **hold** is an interaction with no confirmed break whose validation window
 *    contains a close rejected back past the band (up for support, down for
 *    resistance). A wick touching the level is not, by itself, a hold.
 *  - Interactions whose validation window has not fully closed are not
 *    classified at all, so a still-forming outcome can never leak backwards into
 *    the statistics.
 */

import { atrWilder } from '../technical/calculations';
import type { CanonicalBar } from '../canonical-bars';

export type LevelSide = 'support' | 'resistance';

export interface LevelInput {
  id: string;
  label: string;
  price: number;
  type: LevelSide;
}

export interface LevelStatisticsOptions {
  /** Wilder ATR period used for the tolerance band (default 14). */
  atrPeriod?: number;
  /** Tolerance = ATR × this multiple (default 0.25). */
  toleranceAtrMultiple?: number;
  /** Bars after an interaction in which its outcome is judged (default 3). */
  validationBars?: number;
  /** Minimum bars between two counted interactions with the same level (default 3). */
  cooldownBars?: number;
}

export interface LevelInteraction {
  /** Index of the bar that opened the interaction. */
  index: number;
  time: number;
  outcome: 'hold' | 'break' | 'unresolved';
}

export type LevelStrength = 'strong' | 'moderate' | 'weak';

export interface LevelStatistics {
  id: string;
  label: string;
  price: number;
  type: LevelSide;
  touches: number;
  successfulHolds: number;
  breaks: number;
  lastTouchTime: number | null;
  /** Percentage in [0, 100], or `null` when the level was never tested. */
  holdRate: number | null;
  strength: LevelStrength | null;
  /** The tolerance band half-width actually used at the latest evaluated bar. */
  tolerance: number | null;
  interactions: LevelInteraction[];
}

export interface LevelStatisticsResult {
  status: 'available' | 'unavailable';
  /** Empty when unavailable. */
  levels: LevelStatistics[];
  reason: string | null;
  /** Bars that were actually evaluated (excludes the trailing validation window). */
  evaluatedBars: number;
  methodology: string;
  atrPeriod: number;
  toleranceAtrMultiple: number;
  validationBars: number;
  cooldownBars: number;
}

export const LEVEL_STATISTICS_METHODOLOGY =
  'Touch = bar range intersects ATR-scaled tolerance around the level (one interaction per run, cooldown enforced); '
  + 'Break = confirmed close beyond the tolerance inside the validation window; '
  + 'Hold = no confirmed break plus a close rejected back past the tolerance inside the same window. '
  + 'Computed from the displayed canonical OHLCV only.';

const DEFAULTS = {
  atrPeriod: 14,
  toleranceAtrMultiple: 0.25,
  validationBars: 3,
  cooldownBars: 3,
} as const;

function strengthFor(touches: number, holdRate: number | null): LevelStrength | null {
  if (touches === 0 || holdRate == null) return null;
  if (touches >= 3 && holdRate >= 70) return 'strong';
  if (touches >= 2 && holdRate >= 50) return 'moderate';
  return 'weak';
}

/**
 * Runs the Touch/Hold/Break engine over canonical bars.
 *
 * Callers must pass *finalized* bars (no still-forming bucket); the engine
 * additionally refuses to classify the trailing `validationBars` so every
 * counted outcome is judged on bars that have already closed.
 */
export function calculateLevelStatistics(
  bars: readonly CanonicalBar[],
  levels: readonly LevelInput[],
  options: LevelStatisticsOptions = {},
): LevelStatisticsResult {
  const atrPeriod = options.atrPeriod ?? DEFAULTS.atrPeriod;
  const toleranceAtrMultiple = options.toleranceAtrMultiple ?? DEFAULTS.toleranceAtrMultiple;
  const validationBars = options.validationBars ?? DEFAULTS.validationBars;
  const cooldownBars = options.cooldownBars ?? DEFAULTS.cooldownBars;
  const base = {
    methodology: LEVEL_STATISTICS_METHODOLOGY,
    atrPeriod,
    toleranceAtrMultiple,
    validationBars,
    cooldownBars,
  };

  const usableLevels = levels.filter((level) => Number.isFinite(level.price) && level.price > 0);
  const minimumBars = atrPeriod + validationBars + 1;
  if (bars.length < minimumBars) {
    return {
      ...base,
      status: 'unavailable',
      levels: [],
      evaluatedBars: bars.length,
      reason: `ต้องมีแท่งเทียนอย่างน้อย ${minimumBars} แท่งเพื่อคำนวณสถิติการทดสอบระดับราคา แต่มี ${bars.length} แท่ง`,
    };
  }
  if (!usableLevels.length) {
    return { ...base, status: 'unavailable', levels: [], evaluatedBars: 0, reason: 'ไม่มีระดับราคาที่ใช้คำนวณได้' };
  }

  const atr = atrWilder(
    bars.map((bar) => ({
      date: new Date(bar.time * 1_000).toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })),
    atrPeriod,
  );

  // The last `validationBars` bars cannot host a judged interaction: their
  // outcome window is not complete yet.
  const lastEvaluatable = bars.length - 1 - validationBars;
  const evaluatedBars = Math.max(0, lastEvaluatable - (atrPeriod - 1) + 1);

  const statistics = usableLevels.map((level): LevelStatistics => {
    const interactions: LevelInteraction[] = [];
    let touches = 0;
    let successfulHolds = 0;
    let breaks = 0;
    let lastTouchTime: number | null = null;
    let lastTolerance: number | null = null;
    // Index of the last counted interaction, and whether price has since left
    // the band. Both conditions must be satisfied before a new touch counts.
    let lastInteractionIndex = Number.NEGATIVE_INFINITY;
    let leftBandSinceInteraction = true;

    for (let index = atrPeriod - 1; index <= lastEvaluatable; index += 1) {
      const atrValue = atr[index];
      if (atrValue == null || !Number.isFinite(atrValue) || atrValue <= 0) continue;
      const tolerance = atrValue * toleranceAtrMultiple;
      lastTolerance = tolerance;
      const upper = level.price + tolerance;
      const lower = level.price - tolerance;
      const bar = bars[index];
      const inside = bar.low <= upper && bar.high >= lower;

      if (!inside) {
        leftBandSinceInteraction = true;
        continue;
      }
      if (!leftBandSinceInteraction || index - lastInteractionIndex < cooldownBars) continue;

      touches += 1;
      lastTouchTime = bar.time;
      lastInteractionIndex = index;
      leftBandSinceInteraction = false;

      let outcome: LevelInteraction['outcome'] = 'unresolved';
      for (let step = index + 1; step <= index + validationBars; step += 1) {
        const close = bars[step].close;
        const broke = level.type === 'support' ? close < lower : close > upper;
        if (broke) { outcome = 'break'; break; }
        const rejected = level.type === 'support' ? close > upper : close < lower;
        if (rejected) outcome = 'hold';
      }
      if (outcome === 'break') breaks += 1;
      else if (outcome === 'hold') successfulHolds += 1;
      interactions.push({ index, time: bar.time, outcome });
    }

    const holdRate = touches > 0 ? (successfulHolds / touches) * 100 : null;
    return {
      id: level.id,
      label: level.label,
      price: level.price,
      type: level.type,
      touches,
      successfulHolds,
      breaks,
      lastTouchTime,
      holdRate,
      strength: strengthFor(touches, holdRate),
      tolerance: lastTolerance,
      interactions,
    };
  });

  return { ...base, status: 'available', levels: statistics, evaluatedBars, reason: null };
}
