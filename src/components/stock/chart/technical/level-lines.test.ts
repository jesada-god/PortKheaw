import { describe, expect, it } from 'vitest';
import type { OptionToolPivotLevels } from '../../option-tool-chart/pivot-levels';
import { LEVEL_LINE_WIDTH, buildPriceLineSpecs } from './level-lines';

/** The dark appearance's semantic tokens, as the theme bridge resolves them. */
const DARK = { negative: '#EF4444', positive: '#10B981', accent: '#D7FF00' };
/** Light mode carries much darker tokens; the same builder must pass them through. */
const LIGHT = { negative: '#C93636', positive: '#087A55', accent: '#5F7300' };
const RESISTANCE_COLOR = DARK.negative;
const SUPPORT_COLOR = DARK.positive;
const ACCEPTED_PRICE_COLOR = DARK.accent;

const levels: OptionToolPivotLevels = {
  symbol: 'AAPL',
  basisInterval: '1D',
  sourceTime: 1_785_245_400,
  provider: 'yahoo-finance-chart',
  pivot: 339.52,
  resistance: [343.45, 346.81, 350.74],
  support: [336.16, 332.23, 328.87],
};

const build = (overrides: Partial<Parameters<typeof buildPriceLineSpecs>[0]> = {}) => buildPriceLineSpecs({
  acceptedPrice: 343.43, levels, showLevels: true, colors: DARK, ...overrides,
});

describe('buildPriceLineSpecs', () => {
  it('draws the accepted price as a dashed line at exactly that price', () => {
    const current = build().find((line) => line.id === 'current');
    expect(current).toMatchObject({
      price: 343.43, dashed: true, color: ACCEPTED_PRICE_COLOR, labelSide: 'right', axisLabel: true,
    });
  });

  it('never substitutes a level or an EMA for the accepted price', () => {
    const current = build({ acceptedPrice: 300 }).find((line) => line.id === 'current');
    expect(current?.price).toBe(300);
    expect([...levels.resistance, ...levels.support]).not.toContain(current?.price);
  });

  it('omits the line rather than inventing a price when none is accepted', () => {
    expect(build({ acceptedPrice: null }).some((line) => line.id === 'current')).toBe(false);
    expect(build({ acceptedPrice: Number.NaN }).some((line) => line.id === 'current')).toBe(false);
  });

  it('keeps all six levels at their engine prices, in order', () => {
    const lines = build().filter((line) => line.id !== 'current');
    expect(lines.map((line) => line.id)).toEqual(['R1', 'R2', 'R3', 'S1', 'S2', 'S3']);
    expect(lines.map((line) => line.price)).toEqual([343.45, 346.81, 350.74, 336.16, 332.23, 328.87]);
  });

  it('draws the accepted price after the levels so a coincident level cannot bury it', () => {
    // R1 is 343.45 and the accepted price 343.43: the same pixel row on a
    // year-long chart. Price lines paint in creation order, so this one is last.
    const lines = build();
    expect(lines.at(-1)?.id).toBe('current');
  });

  it('gives every level a 2px solid stroke — heavier than the 1px it used to be', () => {
    build().filter((line) => line.id !== 'current').forEach((line) => {
      expect(line.width).toBe(LEVEL_LINE_WIDTH);
      expect(LEVEL_LINE_WIDTH).toBeGreaterThan(1);
      expect(line.dashed).toBeUndefined();
    });
  });

  it('uses the semantic down colour for resistance and up colour for support', () => {
    const lines = build();
    lines.filter((line) => line.id.startsWith('R')).forEach((line) => {
      expect(line.color.startsWith(RESISTANCE_COLOR)).toBe(true);
      expect(line.labelColor).toBe(RESISTANCE_COLOR);
    });
    lines.filter((line) => line.id.startsWith('S')).forEach((line) => {
      expect(line.color.startsWith(SUPPORT_COLOR)).toBe(true);
      expect(line.labelColor).toBe(SUPPORT_COLOR);
    });
  });

  it('ranks the levels by opacity, keeping the nearest one fully opaque', () => {
    const lines = build();
    expect(lines.find((line) => line.id === 'R1')?.color).toBe(RESISTANCE_COLOR);
    expect(lines.find((line) => line.id === 'R2')?.color).toBe(`${RESISTANCE_COLOR}d9`);
    expect(lines.find((line) => line.id === 'R3')?.color).toBe(`${RESISTANCE_COLOR}b3`);
    expect(lines.find((line) => line.id === 'S1')?.color).toBe(SUPPORT_COLOR);
  });

  it('labels every level on the left and only the accepted price on the right', () => {
    const sides = Object.fromEntries(build().map((line) => [line.id, line.labelSide]));
    expect(sides).toEqual({
      current: 'right', R1: 'left', R2: 'left', R3: 'left', S1: 'left', S2: 'left', S3: 'left',
    });
  });

  it('keeps only the accepted price on the price scale, so six chips cannot pile up there', () => {
    expect(build().filter((line) => line.axisLabel)).toHaveLength(1);
  });

  it('drops the levels when the toggle is off but keeps the accepted price', () => {
    const lines = build({ showLevels: false });
    expect(lines.map((line) => line.id)).toEqual(['current']);
  });

  it('draws nothing extra when the level engine has no result yet', () => {
    expect(build({ levels: null }).map((line) => line.id)).toEqual(['current']);
  });

  it('takes the darker light-mode tokens so a level is not washed out on white', () => {
    const lines = build({ colors: LIGHT });
    expect(lines.find((line) => line.id === 'S1')?.color).toBe(LIGHT.positive);
    expect(lines.find((line) => line.id === 'R1')?.color).toBe(LIGHT.negative);
    expect(lines.find((line) => line.id === 'current')?.color).toBe(LIGHT.accent);
    // Ranking still reads on the light surface.
    expect(lines.find((line) => line.id === 'R3')?.color).toBe(`${LIGHT.negative}b3`);
  });

  it('leaves a non-hex colour notation untouched instead of appending an alpha to it', () => {
    const lines = build({ colors: { ...DARK, negative: 'oklch(0.6 0.2 25)' } });
    expect(lines.find((line) => line.id === 'R3')?.color).toBe('oklch(0.6 0.2 25)');
  });
});
