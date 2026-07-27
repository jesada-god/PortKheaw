/**
 * The one catalog of drawable chart types.
 *
 * `AdvancedChartType` already named every form the chart engine can draw; this
 * catalog gives each of them the label the toolbar shows and the short label the
 * trigger shows, so the menu, the persisted preference and the series factory
 * can never drift apart.
 *
 * A chart type is *presentation only*: switching one re-derives bars already in
 * memory and never reaches a provider.
 */

import type { AdvancedChartType } from './types';

export interface ChartTypeOption {
  id: AdvancedChartType;
  /** Full label in the menu. */
  label: string;
  /** Compact label on the toolbar trigger. */
  short: string;
  /** True when the drawn shape is a transform of, or a reduction from, the traded OHLC. */
  derived: boolean;
}

export const CHART_TYPE_OPTIONS: readonly ChartTypeOption[] = [
  { id: 'candlestick', label: 'แท่งเทียนจริง (Candles)', short: 'Candles', derived: false },
  { id: 'hollow-candles', label: 'แท่งเทียนโปร่ง (Hollow)', short: 'Hollow', derived: false },
  { id: 'heikin-ashi', label: 'Heikin-Ashi', short: 'Heikin-Ashi', derived: true },
  { id: 'ohlc', label: 'แท่ง OHLC (Bar)', short: 'OHLC', derived: false },
  { id: 'line', label: 'เส้นราคาปิด (Line)', short: 'Line', derived: true },
  { id: 'area', label: 'พื้นที่ราคาปิด (Area)', short: 'Area', derived: true },
];

export const CHART_TYPE_IDS = CHART_TYPE_OPTIONS.map((option) => option.id) as [AdvancedChartType, ...AdvancedChartType[]];

const BY_ID = new Map(CHART_TYPE_OPTIONS.map((option) => [option.id, option]));

/** Falls back to real candles so an unknown stored value can never blank the chart. */
export function chartTypeOption(id: AdvancedChartType): ChartTypeOption {
  return BY_ID.get(id) ?? CHART_TYPE_OPTIONS[0];
}
