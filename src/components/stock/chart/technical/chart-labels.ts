/**
 * The chart's in-pane label layer.
 *
 * lightweight-charts prints a series/price-line label on whichever side the price
 * scale sits (always the right here) and puts *only* the series title in it — the
 * value is gated behind `lastValueVisible`, which would also add a price-axis
 * chip per EMA. That is why the EMA labels read "EMA 20" with no number and why
 * every level label piles up on the right edge.
 *
 * So the labels are described here instead, as overlay lines whose stroke is
 * owned elsewhere (`drawLine: false`): the EMA series draws the EMA, a
 * lightweight-charts price line draws the level. This layer only says what text
 * goes where. Being pure, what a label reads and which edge it hugs is testable
 * without a canvas.
 */

import type { LineSpec, OverlayLabelSide } from '@/src/lib/analytics/institutional-sr/overlay-spec';
import type { IndicatorPoint } from '@/src/lib/analytics/chart-indicators';
import { formatPrice } from '@/src/utils/format';

/** Two spaces read as a column gap in a proportional font without a separator glyph. */
const NAME_VALUE_GAP = '  ';

export interface ChartPriceLineSpec {
  id: string;
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  width?: 1 | 2 | 3 | 4;
  /** Pane edge this line's label hugs. Levels go left, the accepted price right. */
  labelSide?: OverlayLabelSide;
  /** Text colour, when the stroke itself is drawn translucent. */
  labelColor?: string;
  /** Whether the price also gets a chip on the right price scale. */
  axisLabel?: boolean;
}

export interface EmaLineSpec {
  id: string;
  label: string;
  color: string;
  points: readonly IndicatorPoint[];
}

export interface ChartLabelInput {
  emaLines: readonly EmaLineSpec[];
  priceLines: readonly ChartPriceLineSpec[];
  /** The chart's own price precision, so a label never invents digits. */
  pricePrecision: number;
}

function labelText(name: string, price: number, precision: number): string {
  return `${name}${NAME_VALUE_GAP}${formatPrice(price, { precision })}`;
}

/**
 * One label per EMA, carrying the newest value of the *plotted* series. An EMA
 * with no drawable point yields no label — never a fabricated `0` — and the
 * value is never taken from the current quote, which would silently relabel the
 * line as something it is not.
 */
export function emaLabelLines(lines: readonly EmaLineSpec[], precision: number): LineSpec[] {
  return lines.flatMap((line) => {
    const latest = line.points.at(-1);
    if (!latest || !Number.isFinite(latest.value)) return [];
    return [{
      id: line.id,
      price: latest.value,
      color: line.color,
      label: labelText(line.label, latest.value, precision),
      dashed: false,
      side: 'right' as const,
      drawLine: false,
    }];
  });
}

/** One label per price line, on the edge that line asked for. */
export function priceLineLabels(lines: readonly ChartPriceLineSpec[], precision: number): LineSpec[] {
  return lines.flatMap((line) => {
    if (!Number.isFinite(line.price)) return [];
    return [{
      id: line.id,
      price: line.price,
      color: line.color,
      labelColor: line.labelColor ?? line.color,
      label: labelText(line.title, line.price, precision),
      dashed: false,
      side: line.labelSide ?? 'left',
      drawLine: false,
    }];
  });
}

export function buildChartLabelLines(input: ChartLabelInput): LineSpec[] {
  return [
    ...priceLineLabels(input.priceLines, input.pricePrecision),
    ...emaLabelLines(input.emaLines, input.pricePrecision),
  ];
}
