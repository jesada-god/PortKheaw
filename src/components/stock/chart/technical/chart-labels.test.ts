import { describe, expect, it } from 'vitest';
import { buildChartLabelLines, emaLabelLines, priceLineLabels, type ChartPriceLineSpec, type EmaLineSpec } from './chart-labels';

const emaPoints = (values: readonly number[]): EmaLineSpec['points'] => values.map((value, index) => ({
  time: 1_760_000_000 + index * 86_400,
  value,
}));

const ema = (id: string, label: string, values: readonly number[]): EmaLineSpec => ({
  id, label, color: '#f59e0b', points: emaPoints(values),
});

const levels: ChartPriceLineSpec[] = [
  { id: 'current', price: 60.64, color: '#D4FF00', title: 'ราคาปัจจุบัน', dashed: true, width: 2, labelSide: 'right', axisLabel: true },
  { id: 'R1', price: 70.23, color: '#ff3b30', title: 'R1', width: 2, labelSide: 'left' },
  { id: 'R2', price: 76.56, color: '#ff3b30d9', labelColor: '#ff3b30', title: 'R2', width: 2, labelSide: 'left' },
  { id: 'S1', price: 60.29, color: '#00c57f', title: 'S1', width: 2, labelSide: 'left' },
];

describe('EMA labels', () => {
  it('carries the name and the latest plotted EMA value', () => {
    const lines = emaLabelLines([ema('ema20', 'EMA 20', [80.1, 85.4231])], 2);
    expect(lines).toHaveLength(1);
    expect(lines[0].label).toBe('EMA 20  85.42');
    expect(lines[0].price).toBe(85.4231);
  });

  it('formats at the chart price precision rather than a fixed two digits', () => {
    const [line] = emaLabelLines([ema('ema20', 'EMA 20', [1.234567])], 4);
    expect(line.label).toBe('EMA 20  1.2346');
  });

  it('hides the label when the EMA has no value — never renders a 0', () => {
    expect(emaLabelLines([ema('ema200', 'EMA 200', [])], 2)).toEqual([]);
    expect(emaLabelLines([{ ...ema('ema200', 'EMA 200', []), points: [{ time: 1, value: Number.NaN }] }], 2)).toEqual([]);
    const rendered = buildChartLabelLines({
      emaLines: [ema('ema200', 'EMA 200', [])],
      priceLines: [],
      pricePrecision: 2,
    });
    expect(rendered.some((line) => line.label.includes('EMA 200'))).toBe(false);
    expect(rendered.some((line) => /\b0\.00\b/.test(line.label))).toBe(false);
  });

  it('reads the EMA series, never the current price', () => {
    const lines = buildChartLabelLines({
      emaLines: [ema('ema20', 'EMA 20', [10, 31.27])],
      priceLines: [{ id: 'current', price: 999.99, color: '#D4FF00', title: 'ราคาปัจจุบัน', labelSide: 'right' }],
      pricePrecision: 2,
    });
    const emaLabel = lines.find((line) => line.label.startsWith('EMA 20'));
    expect(emaLabel?.label).toBe('EMA 20  31.27');
    expect(emaLabel?.price).toBe(31.27);
  });

  it('labels every enabled EMA and keeps each line its own colour', () => {
    const lines = emaLabelLines([
      { ...ema('ema20', 'EMA 20', [85.42]), color: '#f59e0b' },
      { ...ema('ema50', 'EMA 50', [73.18]), color: '#38bdf8' },
      { ...ema('ema100', 'EMA 100', [59.64]), color: '#a78bfa' },
      { ...ema('ema200', 'EMA 200', [31.27]), color: '#f472b6' },
    ], 2);
    expect(lines.map((line) => line.label)).toEqual([
      'EMA 20  85.42', 'EMA 50  73.18', 'EMA 100  59.64', 'EMA 200  31.27',
    ]);
    expect(lines.map((line) => line.color)).toEqual(['#f59e0b', '#38bdf8', '#a78bfa', '#f472b6']);
  });

  it('places every EMA label on the right edge and draws no line of its own', () => {
    const lines = emaLabelLines([ema('ema20', 'EMA 20', [85.42])], 2);
    expect(lines[0].side).toBe('right');
    // The EMA series already draws the curve; the label layer must not restroke it.
    expect(lines[0].drawLine).toBe(false);
  });
});

describe('price-line labels', () => {
  it('puts R and S labels on the left with their real price', () => {
    const lines = priceLineLabels(levels, 2);
    const left = lines.filter((line) => line.side === 'left');
    expect(left.map((line) => line.label)).toEqual(['R1  70.23', 'R2  76.56', 'S1  60.29']);
    expect(left.map((line) => line.price)).toEqual([70.23, 76.56, 60.29]);
  });

  it('keeps the accepted price label on the right', () => {
    const [current] = priceLineLabels(levels, 2);
    expect(current.id).toBe('current');
    expect(current.side).toBe('right');
    expect(current.label).toBe('ราคาปัจจุบัน  60.64');
  });

  it('uses the opaque label colour when the stroke is drawn translucent', () => {
    const r2 = priceLineLabels(levels, 2).find((line) => line.id === 'R2');
    expect(r2?.labelColor).toBe('#ff3b30');
  });

  it('never restrokes a line the chart already owns', () => {
    expect(priceLineLabels(levels, 2).every((line) => line.drawLine === false)).toBe(true);
  });

  it('drops a level with no usable price instead of labelling a fabricated one', () => {
    expect(priceLineLabels([{ id: 'R1', price: Number.NaN, color: '#f00', title: 'R1' }], 2)).toEqual([]);
  });
});

describe('the combined label layer', () => {
  it('keeps every level on the left and the price plus every EMA on the right', () => {
    const lines = buildChartLabelLines({
      emaLines: [ema('ema20', 'EMA 20', [85.42]), ema('ema50', 'EMA 50', [73.18])],
      priceLines: levels,
      pricePrecision: 2,
    });
    const side = Object.fromEntries(lines.map((line) => [line.id, line.side]));
    expect(side).toEqual({
      current: 'right', R1: 'left', R2: 'left', S1: 'left', ema20: 'right', ema50: 'right',
    });
  });

  it('gives every label a unique id so the collision pass cannot pair them up wrongly', () => {
    const lines = buildChartLabelLines({
      emaLines: [ema('ema20', 'EMA 20', [85.42]), ema('ema50', 'EMA 50', [73.18])],
      priceLines: levels,
      pricePrecision: 2,
    });
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
  });
});
