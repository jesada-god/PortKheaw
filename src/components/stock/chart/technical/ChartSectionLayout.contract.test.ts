import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the Chart → Options → S/R stack.
 *
 * jsdom has no layout engine, so these assert the *rules* that keep the stack
 * from overflowing (fluid widths, scroll containers, stacking grids) rather
 * than measuring pixels — the pixel check is a browser step. They also keep
 * provider/transport diagnostics out of the production copy.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const chart = read('src/components/stock/chart/technical/TechnicalAnalysisChart.tsx');
const options = read('src/components/stock/chart/technical/OptionsLevelsPanel.tsx');
const sr = read('src/components/stock/chart/technical/SupportResistancePanel.tsx');
const popover = read('src/components/ui/DetailPopover.tsx');
const candleChart = read('src/components/stock/IntradayChartPanel.tsx');

/** The narrowest supported viewport, in the rem unit Tailwind's min-w-[…] uses. */
const MIN_VIEWPORT_REM = 320 / 16;

describe('Chart section order', () => {
  it('places Options after the chart host and S/R after Options in the source order', () => {
    const chartHost = chart.indexOf('<TechnicalChartHost');
    const optionsPanel = chart.indexOf('<OptionsLevelsPanel');
    const srPanel = chart.indexOf('<SupportResistancePanel');
    expect(chartHost).toBeGreaterThan(-1);
    expect(optionsPanel).toBeGreaterThan(chartHost);
    expect(srPanel).toBeGreaterThan(optionsPanel);
  });

  it('renders the Options slot unconditionally so the order cannot change with its state', () => {
    expect(chart).not.toContain('{preferences.options && <OptionsLevelsPanel');
    expect(chart).toContain('expanded={preferences.options && optionsTicker}');
  });
});

describe('Responsive rules below the chart', () => {
  it('keeps every panel fluid — no fixed pixel widths that can exceed a 320px viewport', () => {
    for (const source of [options, sr, popover]) {
      expect(source).not.toMatch(/\bw-\[\d{3,}px\]/);
      expect(source).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
    }
  });

  it('stacks the three Options summary cards before squeezing them', () => {
    expect(options).toContain('grid-cols-1 gap-2 sm:grid-cols-3');
  });

  it('scrolls the strike table inside its own container instead of widening the page', () => {
    expect(options).toContain('overflow-x-auto');
    const minWidth = options.match(/min-w-\[([\d.]+)rem\]/);
    expect(minWidth).not.toBeNull();
    expect(Number(minWidth![1])).toBeLessThanOrEqual(MIN_VIEWPORT_REM);
  });

  it('caps every popover at the viewport width and uses a bottom sheet on mobile', () => {
    expect(popover).toContain('max-w-[calc(100vw-2rem)]');
    expect(popover).toContain('fixed inset-x-3 bottom-3');
    expect(popover).toContain('sm:absolute');
  });

  it('uses one small ⓘ affordance and no oversized question-mark controls', () => {
    for (const source of [options, sr]) {
      expect(source).toContain('DetailPopover');
      expect(source).not.toMatch(/>\s*\?\s*</);
    }
  });
});

/**
 * The crosshair readout and the in-pane labels compete for the same surface.
 * Levels label the left edge of the price pane and the EMAs plus the accepted
 * price label the right edge, so where the readout may sit is a hard rule rather
 * than a preference — and one jsdom cannot measure, hence a source contract.
 */
describe('Crosshair readout placement', () => {
  const readoutClasses = chart.match(/className="([^"]*)"[^>]*data-testid="chart-tooltip"/)?.[1] ?? '';

  it('is positioned by the shared crosshair readout element', () => {
    expect(readoutClasses).not.toBe('');
    expect(readoutClasses).toContain('absolute');
  });

  it('docks below the price pane on phones, where no horizontal position can clear both label columns', () => {
    // ~270px of readout against a 228–298px price pane: the only way out is down.
    // Every label this chart draws lives on the price pane, so a readout anchored
    // to the bottom of the chart cannot cover one at any price, zoom or viewport.
    expect(readoutClasses).toContain('bottom-8');
    expect(readoutClasses).not.toMatch(/(^|\s)top-\d/);
    expect(readoutClasses).not.toMatch(/(^|\s)left-\d/);
  });

  it('keeps clear of the lightweight-charts attribution mark in the bottom-left corner', () => {
    expect(readoutClasses).toContain('right-2');
    expect(readoutClasses).toContain('max-w-[calc(100%-4rem)]');
  });

  it('returns to the top from sm up, inset past the left label column', () => {
    expect(readoutClasses).toContain('sm:top-2');
    expect(readoutClasses).toContain('sm:left-24');
    // The phone anchors must be released, or the two placements fight.
    expect(readoutClasses).toContain('sm:bottom-auto');
    expect(readoutClasses).toContain('sm:right-auto');
  });
});

describe('Production copy below the chart', () => {
  // The panels below the chart are pure presentation, so their whole source is
  // rendered copy. The candle panel also performs transport work (it reads a
  // Retry-After header), so it is asserted on structure instead.
  const productionCopy = [options, sr].join('\n');

  it('never puts provider or transport words in a primary status label', () => {
    expect(options).not.toMatch(/Alpaca · Delayed|provider-ready|fetch completed/);
    // Provider names appear only through the shared presentation mapper.
    expect(options).not.toMatch(/\{chain\.provider\}/);
    expect(options).toContain('presentOptionsProvenance');
    expect(options).toContain('presentOptionsStatus');
  });

  it('keeps raw diagnostics out of the rendered copy', () => {
    for (const token of ['Too Many Requests', 'Retry-After', 'cacheStatus', 'singleFlight', 'Discarded']) {
      expect(productionCopy, token).not.toContain(token);
    }
    // The user-facing chart metadata is only the timestamp of the last
    // successful data update; source/status details stay internal.
    expect(candleChart).toContain('chart-last-updated');
    expect(candleChart).not.toContain('chart-history-detail');
    expect(candleChart).not.toContain('<DataProvenance');
    expect(candleChart).not.toContain('bars · ');
    expect(candleChart).not.toContain('History: ');
  });

  it('shares one loading/success/failure vocabulary', () => {
    const presentation = read('src/lib/stock-detail/options-presentation.ts');
    expect(presentation).toContain('กำลังโหลดข้อมูล…');
    expect(presentation).toContain('โหลดข้อมูลสำเร็จ');
    expect(presentation).toContain('โหลดข้อมูลไม่สำเร็จ');
  });
});
