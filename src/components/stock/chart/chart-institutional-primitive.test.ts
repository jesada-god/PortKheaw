import { describe, expect, it, vi } from 'vitest';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import { InstitutionalOverlayPrimitive } from './chart-institutional-primitive';
import type { InstitutionalOverlaySpec, LineSpec } from '@/src/lib/analytics/institutional-sr/overlay-spec';

const PANE_WIDTH = 600;
const PANE_HEIGHT = 400;
/** Character width the fake text metrics report, so chip widths are predictable. */
const CHARACTER_WIDTH = 6;

interface StrokedLine { y: number; toX: number; lineWidth: number; color: string; dash: number[] }
interface DrawnText { text: string; x: number; y: number; color: string }
interface DrawnChip { x: number; y: number; width: number; height: number }

function fakeContext() {
  const strokes: StrokedLine[] = [];
  const texts: DrawnText[] = [];
  const chips: DrawnChip[] = [];
  let cursor = { x: 0, y: 0 };
  let dash: number[] = [];
  let pendingChip: DrawnChip | null = null;
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: '',
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(() => { pendingChip = null; }),
    moveTo: vi.fn((x: number, y: number) => { cursor = { x, y }; }),
    lineTo: vi.fn((x: number, y: number) => { cursor = { ...cursor, x }; void y; }),
    stroke: vi.fn(() => {
      strokes.push({
        y: cursor.y, toX: cursor.x, lineWidth: context.lineWidth, color: context.strokeStyle, dash: [...dash],
      });
    }),
    setLineDash: vi.fn((next: number[]) => { dash = next; }),
    measureText: vi.fn((text: string) => ({ width: text.length * CHARACTER_WIDTH })),
    fillText: vi.fn((text: string, x: number, y: number) => {
      texts.push({ text, x, y, color: context.fillStyle });
    }),
    roundRect: vi.fn((x: number, y: number, width: number, height: number) => {
      pendingChip = { x, y, width, height };
    }),
    rect: vi.fn((x: number, y: number, width: number, height: number) => {
      pendingChip = { x, y, width, height };
    }),
    fill: vi.fn(() => { if (pendingChip) chips.push(pendingChip); }),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
  };
  return { context, strokes, texts, chips };
}

/** A series whose price scale is linear over the pane: price 0 at the bottom. */
function fakeSeries(): ISeriesApi<SeriesType> {
  return {
    priceToCoordinate: (price: number) => PANE_HEIGHT - price,
  } as unknown as ISeriesApi<SeriesType>;
}

function render(spec: InstitutionalOverlaySpec) {
  const primitive = new InstitutionalOverlayPrimitive();
  primitive.attached({
    chart: {} as never,
    series: fakeSeries(),
    requestUpdate: () => undefined,
  });
  primitive.setTheme({ background: '#0D120F' });
  primitive.setSpec(spec);
  const painted = fakeContext();
  const target = {
    useBitmapCoordinateSpace: (callback: (scope: unknown) => void) => callback({
      context: painted.context,
      bitmapSize: { width: PANE_WIDTH, height: PANE_HEIGHT },
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  };
  // The label view is the second pane view; the first paints the VPVR histogram.
  const view = primitive.paneViews()[1];
  (view.renderer() as unknown as { draw(target: unknown): void }).draw(target);
  return painted;
}

const line = (overrides: Partial<LineSpec> & Pick<LineSpec, 'id' | 'price' | 'label'>): LineSpec => ({
  color: '#ff3b30', dashed: false, ...overrides,
});

describe('InstitutionalOverlayPrimitive — level lines', () => {
  it('strokes a level across the full pane at the coordinate of its real price', () => {
    const { strokes } = render({
      bands: [],
      lines: [line({ id: 'R1', price: 120, label: 'R1  120.00', width: 2 })],
    });
    expect(strokes).toHaveLength(1);
    expect(strokes[0].y).toBe(PANE_HEIGHT - 120);
    expect(strokes[0].toX).toBe(PANE_WIDTH);
    expect(strokes[0].lineWidth).toBe(2);
    expect(strokes[0].dash).toEqual([]);
  });

  it('honours a dashed line and a per-line width', () => {
    const { strokes } = render({
      bands: [],
      lines: [
        line({ id: 'poc', price: 100, label: 'POC', dashed: true, width: 1 }),
        line({ id: 'R1', price: 200, label: 'R1', width: 2 }),
      ],
    });
    expect(strokes[0].dash.length).toBeGreaterThan(0);
    expect(strokes[0].lineWidth).toBe(1);
    expect(strokes[1].dash).toEqual([]);
    expect(strokes[1].lineWidth).toBe(2);
  });

  it('draws only the label when the stroke belongs to another layer', () => {
    const { strokes, texts } = render({
      bands: [],
      lines: [line({ id: 'ema20', price: 150, label: 'EMA 20  150.00', side: 'right', drawLine: false })],
    });
    expect(strokes).toHaveLength(0);
    expect(texts.map((item) => item.text)).toEqual(['EMA 20  150.00']);
  });
});

describe('InstitutionalOverlayPrimitive — label placement', () => {
  it('hugs the left edge for levels and the right edge for the price and EMAs', () => {
    const { texts, chips } = render({
      bands: [],
      lines: [
        line({ id: 'R1', price: 300, label: 'R1  300.00', side: 'left', drawLine: false }),
        line({ id: 'current', price: 100, label: 'ราคาปัจจุบัน  100.00', side: 'right', drawLine: false }),
      ],
    });
    const left = texts.find((item) => item.text.startsWith('R1'))!;
    const right = texts.find((item) => item.text.startsWith('ราคา'))!;
    expect(left.x).toBeLessThan(PANE_WIDTH / 2);
    expect(right.x).toBeGreaterThan(PANE_WIDTH / 2);
    // Both chips stay inside the pane, so nothing is clipped by an edge.
    chips.forEach((chip) => {
      expect(chip.x).toBeGreaterThanOrEqual(0);
      expect(chip.x + chip.width).toBeLessThanOrEqual(PANE_WIDTH);
    });
  });

  it('offsets labels that collide while leaving both lines on their real prices', () => {
    const { strokes, texts } = render({
      bands: [],
      lines: [
        line({ id: 'R1', price: 200, label: 'R1  200.00', width: 2 }),
        line({ id: 'R2', price: 201, label: 'R2  201.00', width: 2 }),
      ],
    });
    // Lines: exactly where the prices map to.
    expect(strokes.map((item) => item.y)).toEqual([PANE_HEIGHT - 200, PANE_HEIGHT - 201]);
    // Labels: pushed apart, never overlapping.
    const [first, second] = texts;
    expect(Math.abs(first.y - second.y)).toBeGreaterThanOrEqual(16);
  });

  it('lays each edge out on its own, so a left level cannot push a right EMA label', () => {
    const solo = render({
      bands: [],
      lines: [line({ id: 'ema20', price: 200, label: 'EMA 20  200.00', side: 'right', drawLine: false })],
    });
    const together = render({
      bands: [],
      lines: [
        line({ id: 'R1', price: 200, label: 'R1  200.00', side: 'left' }),
        line({ id: 'R2', price: 201, label: 'R2  201.00', side: 'left' }),
        line({ id: 'ema20', price: 200, label: 'EMA 20  200.00', side: 'right', drawLine: false }),
      ],
    });
    const soloY = solo.texts.find((item) => item.text.startsWith('EMA'))!.y;
    const togetherY = together.texts.find((item) => item.text.startsWith('EMA'))!.y;
    expect(togetherY).toBe(soloY);
  });

  it('skips a label whose price is scrolled out of the pane', () => {
    const { texts } = render({
      bands: [],
      lines: [
        line({ id: 'far', price: 900, label: 'FAR', drawLine: false }),
        line({ id: 'near', price: 100, label: 'NEAR', drawLine: false }),
      ],
    });
    expect(texts.map((item) => item.text)).toEqual(['NEAR']);
  });

  it('writes each label in its own colour, using the opaque colour for a translucent line', () => {
    const { texts } = render({
      bands: [],
      lines: [
        line({ id: 'R3', price: 300, label: 'R3  300.00', color: '#ff3b30b3', labelColor: '#ff3b30' }),
        line({ id: 'S1', price: 100, label: 'S1  100.00', color: '#00c57f' }),
      ],
    });
    expect(texts.find((item) => item.text.startsWith('R3'))?.color).toBe('#ff3b30');
    expect(texts.find((item) => item.text.startsWith('S1'))?.color).toBe('#00c57f');
  });

  it('paints a backing chip in the current chart surface colour', () => {
    const primitive = new InstitutionalOverlayPrimitive();
    primitive.attached({ chart: {} as never, series: fakeSeries(), requestUpdate: () => undefined });
    primitive.setTheme({ background: '#FFFFFF' });
    primitive.setSpec({ bands: [], lines: [line({ id: 'R1', price: 200, label: 'R1  200.00' })] });
    const painted = fakeContext();
    const view = primitive.paneViews()[1];
    (view.renderer() as unknown as { draw(target: unknown): void }).draw({
      useBitmapCoordinateSpace: (callback: (scope: unknown) => void) => callback({
        context: painted.context,
        bitmapSize: { width: PANE_WIDTH, height: PANE_HEIGHT },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
    });
    expect(painted.chips).toHaveLength(1);
    expect(painted.context.save).toHaveBeenCalled();
  });
});
