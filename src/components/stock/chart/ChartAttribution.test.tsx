// @vitest-environment jsdom

/**
 * The licence bargain behind removing the in-plot TradingView mark.
 *
 * Lightweight Charts is Apache-2.0 with one added condition: the attribution
 * notice from the upstream NOTICE file, plus a link to tradingview.com, must
 * reach the user. `layout.attributionLogo` pays that by drawing a mark inside
 * the plot, and upstream permits turning it off for a product that pays the debt
 * somewhere else.
 *
 * Here the debt is split in two, so this file checks both halves and the fact
 * that they are still connected. Under the chart: one line of credit carrying
 * the required link. On `/open-source`: the notice verbatim, the version and the
 * licence, reachable from Settings. Remove either half and the option is no
 * longer permitted — so removing either half fails a test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIGHTWEIGHT_CHARTS_NOTICE, OPEN_SOURCE_PAGE } from '@/src/lib/legal/open-source';
import {
  ChartAttribution,
  CHART_ATTRIBUTION_PREFIX,
  TRADINGVIEW_PRODUCT,
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
const openSourcePage = read('app/open-source/page.tsx');
const settingsLinks = read('src/components/settings/LegalSupportLinks.tsx');
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
 * The permission to disable the logo comes from the *installed* package, not a
 * remembered version number. If a bump ships a build without the option, or
 * under different terms, these fail before the option does.
 */
describe('the installed lightweight-charts', () => {
  const manifest = require_('lightweight-charts/package.json') as { version: string; license: string };

  it('is Apache-2.0, and the page quotes the version actually installed', () => {
    expect(manifest.license).toBe('Apache-2.0');
    expect(read('node_modules/lightweight-charts/LICENSE')).toContain('Apache License');
    expect(LIGHTWEIGHT_CHARTS_NOTICE.version).toBe(manifest.version);
    expect(LIGHTWEIGHT_CHARTS_NOTICE.license).toBe('Apache License 2.0');
  });

  it('ships `attributionLogo` as a real layout option, so disabling it is public API', () => {
    const typings = read('node_modules/lightweight-charts/dist/typings.d.ts');
    expect(typings).toContain('attributionLogo: boolean;');
    // Upstream states the exemption in the option's own docs; if that sentence
    // disappears in a future version, the trade this file encodes needs rereading.
    expect(typings).toContain('if you already fulfill this requirement then you can disable this');
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
   * The forbidden alternatives. Each would leave the library still drawing the
   * mark and merely conceal it, which is the thing the licence is about — so they
   * stay out of the chart tree entirely, not just out of the hosts.
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
      scripts: Record<string, string>;
      overrides?: Record<string, unknown>;
      resolutions?: Record<string, unknown>;
    };
    expect(manifest.dependencies['lightweight-charts']).toBe(LIGHTWEIGHT_CHARTS_NOTICE.version);
    expect(manifest.overrides?.['lightweight-charts']).toBeUndefined();
    expect(manifest.resolutions?.['lightweight-charts']).toBeUndefined();
    expect(Object.values(manifest.scripts).join('\n')).not.toMatch(/patch-package|lightweight-charts/);
  });
});

describe('the credit under the chart', () => {
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

  it('is one short line, not a licence block', () => {
    const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toBe(`${CHART_ATTRIBUTION_PREFIX} ${TRADINGVIEW_PRODUCT}`);
    expect(text.length).toBeLessThan(60);
    // The long-form material belongs on the page, not here.
    expect(text).not.toContain('Copyright');
    expect(text).not.toContain('Apache');
  });

  it('carries the required link as a followable anchor, not as inert text', () => {
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(TRADINGVIEW_URL).toBe('https://www.tradingview.com/');
    expect(anchors[0].getAttribute('href')).toBe(TRADINGVIEW_URL);
    expect(anchors[0].textContent).toBe(TRADINGVIEW_PRODUCT);
    expect(anchors[0].getAttribute('rel')).toContain('noreferrer');
  });

  it('stays visible — never sr-only, never hidden, never behind a toggle', () => {
    const footer = container.querySelector('[data-testid="chart-attribution"]');
    expect(footer).not.toBeNull();
    expect(footer!.className).not.toMatch(/(^|\s)(sr-only|hidden)(\s|$)/);
    expect(footer!.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('every screen that draws a chart', () => {
  it('renders the credit beneath the host, unconditionally', () => {
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
    // `createChart`. A new one inherits neither the option nor the credit, so it
    // has to come here and be given both — this is what makes that unavoidable.
    expect(chartCallSites().sort()).toEqual([
      'src/components/stock/chart/LightweightChartHost.tsx',
      'src/components/stock/chart/technical/TechnicalChartHost.tsx',
    ]);
  });
});

/**
 * The other half of the debt. The short credit is only sufficient because this
 * page exists, is public and carries the notice in full.
 */
describe('the open-source page', () => {
  /*
   * Byte for byte against upstream, Cyrillic es in "(с)" included. Written as an
   * escape here so the expectation cannot be quietly normalised by an editor
   * into the Latin letter it resembles.
   */
  it('reproduces the upstream NOTICE verbatim, odd copyright glyph and all', () => {
    expect(LIGHTWEIGHT_CHARTS_NOTICE.notice).toEqual([
      'TradingView Lightweight Charts™',
      'Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/',
    ]);
  });

  it('renders that notice as text and links the licence and the vendor', () => {
    expect(openSourcePage).toContain('openSourceNotices');
    expect(openSourcePage).toContain('item.notice.join');
    expect(openSourcePage).toContain('item.licenseUrl');
    expect(openSourcePage).toContain('item.homepage');
    expect(openSourcePage).toContain('เวอร์ชัน {item.version}');
    expect(LIGHTWEIGHT_CHARTS_NOTICE.licenseUrl).toBe('https://www.apache.org/licenses/LICENSE-2.0');
    expect(LIGHTWEIGHT_CHARTS_NOTICE.homepage).toBe(TRADINGVIEW_URL);
  });

  it('is a public route — an attribution only signed-in readers can reach is not one', () => {
    const protectedPaths = read('src/lib/auth/paths.ts');
    const [, list] = /PROTECTED_PATHS = \[([^\]]*)\]/.exec(protectedPaths) ?? [];
    expect(list).toBeDefined();
    expect(list).not.toContain('open-source');
    expect(OPEN_SOURCE_PAGE.href).toBe('/open-source');
  });

  it('is reachable from Settings, so the notice is not an orphan URL', () => {
    expect(settingsLinks).toContain('OPEN_SOURCE_PAGE.href');
    expect(settingsLinks).toContain('OPEN_SOURCE_PAGE.title');
  });
});
