/**
 * The horizontal lines drawn on the price pane: the accepted price and the
 * classic-pivot levels.
 *
 * Pure on purpose — what is drawn, at which price, in which weight and on which
 * edge its label sits is decided here and asserted in tests, while the chart host
 * only turns these into lightweight-charts price lines. No price is ever computed
 * or adjusted here; the levels arrive from the level engine and the accepted price
 * from the market source, and both are passed through untouched.
 */

import type { OptionToolPivotLevels } from '../../option-tool-chart/pivot-levels';
import type { ChartPriceLineSpec } from './chart-labels';
import { formatSupportResistanceLevelLabel } from './level-label';

/**
 * All three levels share one 2px stroke; the ranking is carried by opacity, which
 * keeps R3/S3 visible without letting six lines flatten the candles behind them.
 */
export const LEVEL_LINE_WIDTH = 2;
const LEVEL_ALPHA = ['', 'd9', 'b3'] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface LevelColors {
  /** Semantic down colour for resistance. */
  negative: string;
  /** Semantic up colour for support. */
  positive: string;
  /** Brand accent for the accepted price. */
  accent: string;
}

export interface LevelLineInput {
  /** The price the rest of the surface treats as current; null when unknown. */
  acceptedPrice: number | null;
  levels: OptionToolPivotLevels | null;
  showLevels: boolean;
  /** Resolved theme colours — light and dark carry different semantic values. */
  colors: LevelColors;
}

/** Alpha is appended only to a plain 6-digit hex; any other notation is left alone. */
function withAlpha(color: string, index: number): string {
  const alpha = LEVEL_ALPHA[index] ?? '';
  return alpha && HEX_COLOR.test(color) ? `${color}${alpha}` : color;
}

export function buildPriceLineSpecs(input: LevelLineInput): ChartPriceLineSpec[] {
  const lines: ChartPriceLineSpec[] = [];
  if (input.showLevels && input.levels) {
    input.levels.resistance.forEach((price, index) => lines.push({
      id: `R${index + 1}`,
      price,
      color: withAlpha(input.colors.negative, index),
      labelColor: input.colors.negative,
      title: formatSupportResistanceLevelLabel(`R${index + 1}`),
      width: LEVEL_LINE_WIDTH,
      labelSide: 'right',
    }));
    input.levels.support.forEach((price, index) => lines.push({
      id: `S${index + 1}`,
      price,
      color: withAlpha(input.colors.positive, index),
      labelColor: input.colors.positive,
      title: formatSupportResistanceLevelLabel(`S${index + 1}`),
      width: LEVEL_LINE_WIDTH,
      labelSide: 'right',
    }));
  }
  if (input.acceptedPrice != null && Number.isFinite(input.acceptedPrice)) {
    // Dashed and in the accent colour, so it can never be read as one of the
    // solid level lines, and the only line that keeps a price-scale chip.
    //
    // Last in the array on purpose: price lines paint in creation order, and the
    // accepted price routinely sits within a pixel of R1 or S1. Drawn earlier it
    // would be buried under that level exactly when it matters most.
    lines.push({
      id: 'current',
      price: input.acceptedPrice,
      color: input.colors.accent,
      title: 'ราคาปัจจุบัน',
      dashed: true,
      width: LEVEL_LINE_WIDTH,
      labelSide: 'right',
      axisLabel: true,
    });
  }
  return lines;
}
