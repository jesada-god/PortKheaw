import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { TechnicalIndicatorId } from '@/src/lib/analytics/technical/types';

export interface ChartBar {
  time: UTCTimestamp;
  sourceTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  rawOpen: number;
  rawHigh: number;
  rawLow: number;
  rawClose: number;
  transformed: boolean;
  transactions?: number;
  vwap?: number;
  partial: boolean;
}

export interface ChartPriceLine {
  id: string;
  price: number;
  title: string;
  color: string;
  lineStyle?: number;
}

export interface ChartIndicatorLine {
  id: TechnicalIndicatorId | string;
  label: string;
  color: string;
  pane: number;
  data: Array<{ time: Time; value: number }>;
}

export interface ChartTooltipContext {
  provider?: string;
  range?: string;
  interval?: string;
  dataStatus?: string;
  timezone?: string;
}

export interface ChartActions {
  fitContent(): void;
  reset(): void;
}
