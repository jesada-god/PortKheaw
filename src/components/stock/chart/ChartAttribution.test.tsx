// @vitest-environment jsdom

/**
 * The licence bargain behind removing the in-plot TradingView mark.
 *
 * Lightweight Charts is Apache-2.0 with one added condition: the attribution
 * notice from the upstream NOTICE file, plus a link to tradingview.com, must
 * reach the user. The library's `layout.attributionLogo` option pays that debt
 * by drawing a mark inside the plot, and upstream explicitly permits turning it
 * off for a product that pays the debt somewhere else.
 *
 * So the two halves are only correct together, and this file refuses to let them
 * drift apart. One half asserts the mark is gone through the *supported option*
 * and not through a stylesheet or a DOM edit; the other asserts the footer that
 * replaces it is real, unconditional and carries the notice verbatim. A change
 * that satisfies one half alone fails here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChartAttribution,
  TRADINGVIEW_LICENSE_URL,
  TRADINGVIEW_NOTICE_COPYRIGHT,
  TRADINGVIEW_NOTICE_PRODUCT,
  TRADINGVIEW_URL,
} from './ChartAttribution';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

const require_ = createRequire(import.meta.url);
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const priceHost = read('src/components/stock/chart/LightweightChartHost.tsx');
const technicalHost = read('src/components/stock/chart/technical/TechnicalChartHost.tsx');
const priceParent = read('src/components/stock/chart/StockChart.tsx');
const technicalParent = read('src/components/stock/chart/technical/TechnicalAnalysisChart.tsx');
const hosts = { LightweightChartHost: priceHost, TechnicalChartHost: technicalHost };
const parents = { StockChart: priceParent, TechnicalAnalysisChart: technicalParent };

/** Every file under `src/` and `app/` that instantiates a chart, as repo paths. */
function chartCallSites(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(process.cwd(), directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (read(path).includes('createChart(')) found.push(path);
    }
  };
  walk('src');
  walk('app');
  return found;
}

/**
 * The permission to disable the logo comes from the *installed* package, not
 * from a remembered version number. If a bump ever ships a build without the
 * option, or under different terms, these fail before the option does.
 */
describe('the installed lightweight-charts', () => {
  const manifest = require_('lightweight-charts/package.json') as { version: string; license: string };

  it('is Apache-2.0, which is the licence the footer notice answers to', () => {
    expect(manifest.license).toBe('Apache-2.0');
    expect(read('node_modules/lightweight-charts/LICENSE')).toContain('Apache License');
  });

  it('ships `attributionLogo` as a real layout option, so disabling it is public API', () => {
    const typings = read('node_modules/lightweight-charts/dist/typings.d.ts');
    expect(typings).toContain('attributionLogo: boolean;');
    // Upstream states the exemption in the option's own docs; if that sentence
    // disappears in a future version, the trade this file encodes needs rereading.
    expect(typings).toContain('if you already fulfill this requirement then you can disable this');
    expect(manifest.version.startsWith('5.')).toBe(true);
  });
});

describe('the plot area', () => {
  it('turns the mark off through the layout option in both chart hosts', () => {
    for (const [name, source] of Object.entries(hosts)) {
      expect(source, name).toContain('attributionLogo: false');
      expect(source, name).not.toContain('attributionLogo: true');
    }
  });

  /*
   * The forbidden alternatives. Each of these would leave the library still
   * drawing the mark and merely conceal it, which is the thing the licence is
   * about — so they stay out of the chart tree entirely, not just out of the hosts.
   */
  it('never hides the mark with CSS, a DOM edit or a cover instead', () => {
    const chartTree = [...Object.values(hosts), ...Object.values(parents)].join('\n');
    for (const pattern of [
      /tv-attr-logo/i,
      /#tv-attr/i,
      /removeChild[^\n]*logo/i,
      /querySelector[^\n]*(logo|attribution)/i,
      /visibility:\s*hidden/i,
      /display:\s*none/i,
    ]) {
      expect(chartTree, String(pattern)).not.toMatch(pattern);
    }
  });

  it('leaves the library untouched — the option is passed, the dependency is not patched', () => {
    const manifest = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      // A patch step would have to be declared somewhere runnable.
      scripts: Record<string, string>;
      overrides?: Record<string, unknown>;
      resolutions?: Record<string, unknown>;
    };
    expect(manifest.dependencies['lightweight-charts']).toBe('5.2.0');
    expect(manifest.overrides?.['lightweight-charts']).toBeUndefined();
    expect(manifest.resolutions?.['lightweight-charts']).toBeUndefined();
    expect(Object.values(manifest.scripts).join('\n')).not.toMatch(/patch-package|lightweight-charts/);
  });
});

describe('the footer that pays for it', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => { root.render(<ChartAttribution />); });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  /*
   * Byte-for-byte against upstream, including the Cyrillic es in "(с)". Written
   * as an escape here so the expectation cannot be quietly normalised by an
   * editor into the Latin letter it resembles.
   */
  it('reproduces the upstream NOTICE verbatim, odd copyright glyph and all', () => {
    expect(TRADINGVIEW_NOTICE_PRODUCT).toBe('TradingView Lightweight Charts™');
    expect(TRADINGVIEW_NOTICE_COPYRIGHT).toBe('Copyright (с) 2025 TradingView, Inc.');
    const text = container.textContent ?? '';
    expect(text).toContain(TRADINGVIEW_NOTICE_PRODUCT);
    expect(text).toContain(TRADINGVIEW_NOTICE_COPYRIGHT);
  });

  it('carries the required link as a followable anchor, not as inert text', () => {
    const tradingView = [...container.querySelectorAll('a')]
      .find((anchor) => anchor.getAttribute('href') === TRADINGVIEW_URL);
    expect(TRADINGVIEW_URL).toBe('https://www.tradingview.com/');
    expect(tradingView).toBeDefined();
    expect(tradingView!.textContent).toContain('tradingview.com');
    expect(tradingView!.getAttribute('rel')).toContain('noreferrer');
  });

  it('names the licence it is served under and links to its text', () => {
    const licence = [...container.querySelectorAll('a')]
      .find((anchor) => anchor.getAttribute('href') === TRADINGVIEW_LICENSE_URL);
    expect(licence).toBeDefined();
    expect(licence!.textContent).toContain('Apache License 2.0');
  });

  it('stays visible — never sr-only, never hidden, never behind a toggle', () => {
    const footer = container.querySelector('[data-testid="chart-attribution"]');
    expect(footer).not.toBeNull();
    expect(footer!.className).not.toMatch(/(^|\s)(sr-only|hidden)(\s|$)/);
    expect(footer!.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('every screen that draws a chart', () => {
  it('renders the footer beneath the host, unconditionally', () => {
    const hostTag = {
      StockChart: '<LightweightChartHost',
      TechnicalAnalysisChart: '<TechnicalChartHost',
    } as const;
    for (const [name, source] of Object.entries(parents)) {
      expect(source, name).toContain('<ChartAttribution');
      // After the host in source order: a footer, not an overlay above the plot.
      expect(source.indexOf('<ChartAttribution'), name)
        .toBeGreaterThan(source.indexOf(hostTag[name as keyof typeof hostTag]));
      // No `&&`/`?` gate in front of it, and no toggle key it could be tied to.
      expect(source, name).not.toMatch(/[&?]\s*<ChartAttribution/);
    }
  });

  it('has no chart left anywhere in the app without one', () => {
    // The pair above is the whole surface only for as long as nobody adds a third
    // `createChart`. A new one inherits neither the option nor the footer, so it
    // has to come here and be given both — this is what makes that unavoidable.
    expect(chartCallSites().sort()).toEqual([
      'src/components/stock/chart/LightweightChartHost.tsx',
      'src/components/stock/chart/technical/TechnicalChartHost.tsx',
    ]);
  });
});
