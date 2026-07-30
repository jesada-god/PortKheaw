import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { InstitutionalOverlaySpec, LineSpec } from '@/src/lib/analytics/institutional-sr/overlay-spec';
import { layoutLabelColumn } from './chart-label-layout';

interface BitmapScope {
  context: CanvasRenderingContext2D;
  bitmapSize: { width: number; height: number };
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
}
interface BitmapTarget {
  useBitmapCoordinateSpace(callback: (scope: BitmapScope) => void): void;
}

const LABEL_FONT_SIZE = 11;
const LABEL_FONT_STACK = 'system-ui, -apple-system, sans-serif';
const LABEL_HEIGHT = 18;
/** Distance from the pane edge to the label chip. */
const LABEL_INSET = 8;
const LABEL_PADDING_X = 5;
const LABEL_RADIUS = 3;
/** How solid the chip behind a label is, so text stays readable over candles. */
const LABEL_BACKGROUND_ALPHA = 0.82;

/** Chart-surface colours the labels need; refreshed when the appearance changes. */
export interface OverlayLabelTheme {
  background: string;
}

const DEFAULT_LABEL_THEME: OverlayLabelTheme = { background: '#0D120F' };

/**
 * A lightweight-charts series primitive that paints the institutional overlays:
 * translucent demand/supply zone bands and labeled POC/VAH/VAL/AVWAP lines. It
 * reads price→coordinate from the attached series each frame, so it follows zoom
 * and pan without recreating anything. All drawing is guarded against a detached
 * series/chart, keeping overlay updates disposal-safe.
 */
export class InstitutionalOverlayPrimitive implements ISeriesPrimitive<Time> {
  private spec: InstitutionalOverlaySpec = { bands: [], lines: [] };
  private theme: OverlayLabelTheme = DEFAULT_LABEL_THEME;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly view: IPrimitivePaneView;
  /** The VPVR histogram paints *behind* the price action so candles stay readable. */
  private readonly histogramView: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: unknown) => this.draw(target as BitmapTarget),
    };
    this.view = { renderer: () => renderer, zOrder: () => 'top' };
    const histogramRenderer: IPrimitivePaneRenderer = {
      draw: (target: unknown) => this.drawHistogramPane(target as BitmapTarget),
    };
    this.histogramView = { renderer: () => histogramRenderer, zOrder: () => 'bottom' };
  }

  attached(param: { chart: IChartApi; series: ISeriesApi<SeriesType>; requestUpdate: () => void }): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.histogramView, this.view];
  }

  setSpec(spec: InstitutionalOverlaySpec): void {
    this.spec = spec;
    this.requestUpdate?.();
  }

  /** Test seam and read-back for the host: the spec currently being painted. */
  currentSpec(): InstitutionalOverlaySpec {
    return this.spec;
  }

  setTheme(theme: OverlayLabelTheme): void {
    this.theme = theme;
    this.requestUpdate?.();
  }

  private priceY(price: number, ratio: number): number | null {
    const series = this.series;
    if (!series) return null;
    let coordinate: number | null = null;
    try {
      coordinate = series.priceToCoordinate(price);
    } catch {
      return null; // series may be mid-teardown
    }
    return coordinate == null ? null : coordinate * ratio;
  }

  /**
   * Right-anchored volume-by-price histogram. Bars are drawn behind the price
   * action from the already-computed visible-range bins, so panning and zooming
   * only re-slice loaded candles — nothing is fetched to repaint this.
   */
  private drawHistogram(ctx: CanvasRenderingContext2D, width: number, vr: number): void {
    const histogram = this.spec.histogram;
    if (!histogram?.bars.length) return;
    const maximumWidth = width * Math.max(0.05, Math.min(1, histogram.widthRatio));
    for (const bar of histogram.bars) {
      if (bar.ratio <= 0) continue;
      const yHigh = this.priceY(bar.priceHigh, vr);
      const yLow = this.priceY(bar.priceLow, vr);
      if (yHigh == null || yLow == null) continue;
      const top = Math.min(yHigh, yLow);
      const height = Math.max(1, Math.abs(yLow - yHigh) - Math.max(1, vr * 0.5));
      const barWidth = Math.max(1, maximumWidth * bar.ratio);
      ctx.fillStyle = bar.kind === 'poc'
        ? 'rgba(212, 255, 0, 0.55)'
        : bar.kind === 'value-area'
          ? 'rgba(148, 163, 184, 0.38)'
          : 'rgba(148, 163, 184, 0.18)';
      ctx.fillRect(width - barWidth, top, barWidth, height);
    }
  }

  private drawHistogramPane(target: BitmapTarget): void {
    if (!this.series || !this.spec.histogram?.bars.length) return;
    target.useBitmapCoordinateSpace((scope) => {
      this.drawHistogram(scope.context, scope.bitmapSize.width, scope.verticalPixelRatio);
    });
  }

  /**
   * One label chip: a rounded plate in the chart background so the text stays
   * readable over candles, then the text in the line's own colour.
   */
  private drawLabelChip(
    ctx: CanvasRenderingContext2D,
    text: string,
    color: string,
    side: 'left' | 'right',
    centerY: number,
    paneWidth: number,
    hr: number,
    vr: number,
  ): void {
    const paddingX = LABEL_PADDING_X * hr;
    const chipWidth = ctx.measureText(text).width + paddingX * 2;
    const chipHeight = LABEL_HEIGHT * vr;
    const inset = LABEL_INSET * hr;
    const x = side === 'right'
      ? Math.max(inset, paneWidth - inset - chipWidth)
      : inset;
    const top = centerY - chipHeight / 2;
    ctx.save();
    ctx.globalAlpha = LABEL_BACKGROUND_ALPHA;
    ctx.fillStyle = this.theme.background;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, top, chipWidth, chipHeight, LABEL_RADIUS * hr);
    else ctx.rect(x, top, chipWidth, chipHeight);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(text, x + paddingX, centerY);
  }

  /**
   * Lines are stroked at the coordinate their price maps to; only the labels go
   * through the collision pass, and each side of the pane is laid out on its own.
   * Labels assigned to one edge share that edge's collision column.
   */
  private drawLines(ctx: CanvasRenderingContext2D, paneWidth: number, paneHeight: number, hr: number, vr: number): void {
    const drawable: Array<{ line: LineSpec; y: number }> = [];
    for (const line of this.spec.lines) {
      const y = this.priceY(line.price, vr);
      if (y == null) continue;
      drawable.push({ line, y });
      if (line.drawLine === false) continue;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = Math.max(1, Math.round((line.width ?? 1) * vr));
      ctx.setLineDash(line.dashed ? [6 * hr, 4 * hr] : []);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(paneWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const side of ['left', 'right'] as const) {
      const column = drawable.filter(({ line }) => (line.side ?? 'left') === side);
      const placements = layoutLabelColumn(
        column.map(({ line, y }) => ({ id: line.id, y })),
        { height: paneHeight, labelHeight: LABEL_HEIGHT * vr },
      );
      for (const placement of placements) {
        const item = column[placement.index];
        if (!item) continue;
        this.drawLabelChip(
          ctx,
          item.line.label,
          item.line.labelColor ?? item.line.color,
          side,
          placement.y,
          paneWidth,
          hr,
          vr,
        );
      }
    }
  }

  private draw(target: BitmapTarget): void {
    if (!this.series) return;
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope;
      const width = bitmapSize.width;

      for (const band of this.spec.bands) {
        const yHigh = this.priceY(band.high, vr);
        const yLow = this.priceY(band.low, vr);
        if (yHigh == null || yLow == null) continue;
        const top = Math.min(yHigh, yLow);
        const height = Math.max(1, Math.abs(yLow - yHigh));
        ctx.fillStyle = band.fill;
        ctx.fillRect(0, top, width, height);
        ctx.strokeStyle = band.border;
        ctx.lineWidth = Math.max(1, vr);
        ctx.strokeRect(0, top, width, height);
      }

      ctx.font = `${Math.round(LABEL_FONT_SIZE * vr)}px ${LABEL_FONT_STACK}`;
      ctx.textBaseline = 'middle';
      this.drawLines(ctx, width, bitmapSize.height, hr, vr);

      // Band labels at the band top edge.
      for (const band of this.spec.bands) {
        const yHigh = this.priceY(band.high, vr);
        if (yHigh == null) continue;
        ctx.fillStyle = band.labelColor;
        ctx.fillText(band.label, LABEL_INSET * hr, yHigh + LABEL_HEIGHT * 0.6 * vr);
      }
    });
  }
}
