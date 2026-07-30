import type { InstitutionalZone } from './types';
import type { VisibleRangeVolumeProfile } from './visible-range-profile';
import type { AnchoredVwapResult } from './anchored-vwap';

/**
 * Neutral, renderer-agnostic overlay specifications. The chart primitive consumes
 * these; keeping the transform pure makes label text, colours and geometry unit
 * testable without a canvas.
 */
export interface BandSpec {
  id: string;
  low: number;
  high: number;
  fill: string;
  border: string;
  label: string;
  labelColor: string;
}

/** Pane edge a label hugs. Callers choose the side for their collision column. */
export type OverlayLabelSide = 'left' | 'right';

export interface LineSpec {
  id: string;
  price: number;
  color: string;
  label: string;
  dashed: boolean;
  /** Defaults to the left edge, which is what every overlay line has always used. */
  side?: OverlayLabelSide;
  /** Line thickness in CSS pixels; defaults to 1. */
  width?: number;
  /**
   * False when the stroke belongs to something else — an EMA series, a
   * lightweight-charts price line — and only the label is drawn from this spec.
   */
  drawLine?: boolean;
  /** Text colour when the line is drawn translucent; defaults to `color`. */
  labelColor?: string;
}

/** One horizontal VPVR bar: a price bin drawn as a right-anchored volume column. */
export interface HistogramBarSpec {
  priceLow: number;
  priceHigh: number;
  /** Bin volume relative to the peak bin, in [0, 1]. */
  ratio: number;
  kind: 'poc' | 'value-area' | 'outside';
}

export interface HistogramSpec {
  bars: HistogramBarSpec[];
  /** Share of the pane width the peak bar may occupy, in (0, 1]. */
  widthRatio: number;
}

export interface InstitutionalOverlaySpec {
  bands: BandSpec[];
  lines: LineSpec[];
  /** Right-anchored volume-by-price histogram (VPVR); absent when hidden. */
  histogram?: HistogramSpec;
}

const DEMAND_FILL = 'rgba(52, 211, 153, 0.14)';
const DEMAND_BORDER = 'rgba(52, 211, 153, 0.55)';
const SUPPLY_FILL = 'rgba(251, 113, 133, 0.14)';
const SUPPLY_BORDER = 'rgba(251, 113, 133, 0.55)';

const STRENGTH_TAG: Record<InstitutionalZone['strength'], string> = { strong: '●●●', moderate: '●●', weak: '●' };

export function zoneBands(zones: readonly InstitutionalZone[]): BandSpec[] {
  return zones.map((zone, index) => {
    const demand = zone.type === 'demand';
    const prefix = demand ? 'D' : 'S';
    return {
      id: zone.id,
      low: zone.low,
      high: zone.high,
      fill: demand ? DEMAND_FILL : SUPPLY_FILL,
      border: demand ? DEMAND_BORDER : SUPPLY_BORDER,
      label: `${prefix}${index + 1} ${STRENGTH_TAG[zone.strength]} ${zone.score.toFixed(0)}`,
      labelColor: demand ? '#34d399' : '#fb7185',
    };
  });
}

export function volumeProfileLines(profile: VisibleRangeVolumeProfile | undefined): LineSpec[] {
  if (!profile || profile.status !== 'available') return [];
  return [
    { id: 'vrvp-poc', price: profile.poc, color: '#D4FF00', label: 'POC', dashed: false },
    { id: 'vrvp-vah', price: profile.vah, color: '#94a3b8', label: 'VAH', dashed: true },
    { id: 'vrvp-val', price: profile.val, color: '#94a3b8', label: 'VAL', dashed: true },
  ];
}

/**
 * Turns the visible-range profile into drawable histogram bars. Bins are already
 * deterministic and normalized upstream; this only classifies each bin against
 * the value area so the POC and the 70% band read differently on screen.
 */
export function volumeProfileHistogram(
  profile: VisibleRangeVolumeProfile | undefined,
  widthRatio = 0.22,
): HistogramSpec | undefined {
  if (!profile || profile.status !== 'available' || !profile.profile.length) return undefined;
  const pocBin = profile.profile.reduce((best, bin) => (bin.volume > best.volume ? bin : best));
  return {
    widthRatio,
    bars: profile.profile.map((bin) => ({
      priceLow: bin.priceLow,
      priceHigh: bin.priceHigh,
      ratio: Math.max(0, Math.min(1, bin.normalizedVolume)),
      kind: bin.index === pocBin.index
        ? 'poc'
        : bin.priceHigh > profile.val && bin.priceLow < profile.vah
          ? 'value-area'
          : 'outside',
    })),
  };
}

export function anchoredVwapLine(result: AnchoredVwapResult | undefined): LineSpec[] {
  if (!result || result.status !== 'available') return [];
  return [{ id: 'avwap', price: result.value, color: '#38bdf8', label: 'AVWAP', dashed: false }];
}

export function buildInstitutionalOverlaySpec(input: {
  zones?: readonly InstitutionalZone[];
  showZones: boolean;
  profile?: VisibleRangeVolumeProfile;
  showVolumeProfile: boolean;
  avwap?: AnchoredVwapResult;
  showAnchoredVwap: boolean;
  /** Draw the VPVR histogram, not only its POC/VAH/VAL reference lines. */
  showVolumeProfileHistogram?: boolean;
}): InstitutionalOverlaySpec {
  const histogram = input.showVolumeProfileHistogram ? volumeProfileHistogram(input.profile) : undefined;
  return {
    bands: input.showZones && input.zones ? zoneBands(input.zones) : [],
    lines: [
      ...(input.showVolumeProfile ? volumeProfileLines(input.profile) : []),
      ...(input.showAnchoredVwap ? anchoredVwapLine(input.avwap) : []),
    ],
    ...(histogram ? { histogram } : {}),
  };
}
