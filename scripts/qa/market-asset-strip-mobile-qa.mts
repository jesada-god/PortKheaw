/**
 * THE ASSET BAND AT 375px, MEASURED RATHER THAN EYEBALLED.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A TEST
 * ===========================================================================
 * Every question here needs a LAYOUT ENGINE. Does "น้ำมัน WTI" still fit beside
 * a 16px mark in a 7.5rem column, or does it truncate? How much taller is a
 * cell once it carries a sparkline? jsdom answers neither — it has no box model
 * — and `MarketTodaySection.test.tsx` therefore pins what the markup SAYS while
 * this pins what it MEASURES.
 *
 * ===========================================================================
 * WHY IT RENDERS THE COMPONENT AND NOT THE PAGE
 * ===========================================================================
 * `overview-phase2-qa.mjs` captures the whole Overview and needs a deployment,
 * a signed-in storage state and `PHASE2_MARKET_SNAPSHOT` set on a server. All
 * three are shared state. The band is a pure presentational component over
 * plain data, so it is server-rendered here into the app's own compiled
 * stylesheet — the real `globals.css`, through the real Tailwind pipeline, so
 * `--page-gutter`, `.data-strip--flow` and every utility resolve exactly as
 * they do in the product.
 *
 * The strip is placed inside the same `<main>` the dashboard draws it in, at
 * the same max width and gutter, because `.bleed-mobile` is defined as the
 * negative of that gutter and measuring it outside one would measure a
 * different element.
 *
 * ===========================================================================
 * WHAT IT REPORTS
 * ===========================================================================
 *   * the height of every cell, and the tallest — the number a change to this
 *     band is allowed or not allowed to move;
 *   * whether each name is truncated, by comparing the label's scroll width
 *     against its client width, which is the only way to catch an ellipsis;
 *   * whether the strip's own scroller overflows the viewport rather than
 *     scrolling inside itself.
 *
 * Run: npm run qa:asset-strip
 * A baseline for comparison: npm run qa:asset-strip -- --label before
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MARKET_ASSETS, assetsOutsideMarketStatus } from '@/src/lib/overview/market-assets';
import { MarketAssetStrip } from '@/src/components/dashboard/MarketTodaySection';
import type { MarketIndexCard } from '@/src/lib/overview/types';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1]! : 'current';
const OUT_DIR = '.qa/artifacts/market-asset-strip';
const WIDTH = 375;

/**
 * A believable intraday shape, so the sparkline is measured at the length it
 * really carries. The live band returns 79 five-minute closes for a US equity
 * and 276-290 for a contract or a 24/7 asset; the count is what decides whether
 * a polyline is a line or a smear, so it is not rounded off here.
 */
function series(points: number, base: number, drift: number): number[] {
  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const wave = Math.sin(progress * 7) * base * 0.004;
    return base * (1 + drift * progress) + wave;
  });
}

const LIVE: Record<string, { price: number; changePercent: number; points: number }> = {
  SPY: { price: 761.78, changePercent: -0.687, points: 79 },
  QQQ: { price: 707.64, changePercent: -1.272, points: 79 },
  DIA: { price: 527.75, changePercent: -0.719, points: 79 },
  IWM: { price: 290.57, changePercent: -0.503, points: 79 },
  'GC-F': { price: 4361.1, changePercent: -1.364, points: 276 },
  'SI-F': { price: 64.4, changePercent: -1.462, points: 276 },
  'CL-F': { price: 90.44, changePercent: 2.738, points: 276 },
  REMX: { price: 76.19, changePercent: -0.21, points: 79 },
  'BTC-USD': { price: 76790, changePercent: -1.435, points: 290 },
};

function cards(): MarketIndexCard[] {
  return MARKET_ASSETS.map((asset) => {
    const live = LIVE[asset.symbol]!;
    return {
      symbol: asset.symbol,
      instrument: {
        symbol: asset.symbol,
        companyName: asset.name,
        logoUrl: asset.logoUrl,
        assetType: 'ETF',
        exchange: null,
        currency: 'USD',
      },
      price: live.price,
      currency: 'USD',
      change: live.price * live.changePercent / 100,
      changePercent: live.changePercent,
      session: 'CLOSED',
      sessionLabel: 'ปิดตลาด',
      status: 'closed',
      asOf: '2026-09-01T20:00:00.000Z',
      tradingDate: '2026-09-01',
      extended: null,
      freshness: null,
      sparkline: series(live.points, live.price, live.changePercent / 100),
      name: asset.name,
      proxyLabel: asset.proxyLabel,
      subtitle: `${asset.symbol} · ${asset.proxyLabel}`,
    } as unknown as MarketIndexCard;
  });
}

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  const css = await readFile(entry, 'utf8');
  const result = await postcss([tailwind()]).process(css, { from: entry });
  return result.css;
}

/**
 * Read one cell. `scrollWidth > clientWidth` on the label is the only reliable
 * report of a truncation — the text is still in `textContent` either way, so
 * asserting on the string would find nothing wrong with an ellipsis.
 */
const PROBE = `() => {
  const strip = document.querySelector('[data-testid="market-today-assets"]');
  if (!strip) return { missing: true };
  /*
    The cells are the strip's own children. Matching on the testid prefix picks
    up the proxy note, the name span and the sparkline as well — all three carry
    a "market-asset-" testid and none of them is a cell.
  */
  const cells = [...strip.querySelectorAll('.data-strip > *')];
  return {
    stripScrollWidth: strip.scrollWidth,
    stripClientWidth: strip.clientWidth,
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    cells: cells.map((cell) => {
      const label = cell.querySelector('.figure-label');
      const name = label && (label.querySelector('[data-testid$="-name"]') || label);
      const box = cell.getBoundingClientRect();
      const spark = cell.querySelector('[data-testid^="market-asset-spark-"]');
      return {
        symbol: cell.dataset.testid.replace('market-asset-', ''),
        height: Math.round(box.height * 10) / 10,
        width: Math.round(box.width * 10) / 10,
        tag: cell.tagName,
        name: (name.textContent || '').trim(),
        nameTruncated: name.scrollWidth > name.clientWidth + 1,
        /*
          The text's own width, and the width it has to live in.

          The name span is a flex item that shrinks to its content, so its own
          clientWidth is never wider than its text and cannot report a margin.
          The room actually available is from where the name starts to where the
          label row ends -- the mark and the gap already taken out. That
          difference is what decides whether the column floor has to grow.
        */
        nameWidth: name.scrollWidth,
        nameRoom: Math.round((
          label.getBoundingClientRect().right - name.getBoundingClientRect().left
        ) * 10) / 10,
        hasLogo: Boolean(cell.querySelector('img, [role="img"]')),
        sparkHeight: spark ? Math.round(spark.getBoundingClientRect().height * 10) / 10 : null,
        classes: cell.className,
      };
    }),
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

const items = assetsOutsideMarketStatus(cards());
const html = '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
  + `<head><meta charset="utf-8"><style>${css}</style></head>`
  + '<body style="background:var(--bg)">'
  /*
    The dashboard's own wrapper. `.bleed-mobile` is the negative of
    `--page-gutter`, so the strip has to sit inside something that applies it or
    the measurement is of a different element.
  */
  + '<main class="mx-auto w-full max-w-[1440px] page-stack px-[var(--page-gutter)] py-4 sm:py-6">'
  + '<section id="market-overview" class="stack-lead">'
  + renderToString(React.createElement(MarketAssetStrip, { items }))
  + '</section></main></body></html>';

const page = await browser.newPage({
  viewport: { width: WIDTH, height: 900 },
  // Twice the pixels, so a 16px mark and a 1.5px stroke are legible in the
  // artefact. The LAYOUT is unaffected: every measurement below is in CSS px.
  deviceScaleFactor: 2,
});
/*
 * A SYNTHETIC ORIGIN, SO THE BUNDLED MARKS ACTUALLY LOAD.
 *
 * `setContent` leaves the document on `about:blank`, where `/market-logos/gc-f.svg`
 * resolves to nothing — the browser never even issues the request, so a route
 * handler alone cannot save it and every logo renders as the broken-image
 * glyph. That would make this a picture of the harness rather than of the band.
 *
 * Navigating to a URL that only this handler answers gives the page a real
 * origin: the document comes from memory and `public/` is served underneath it,
 * exactly where Next serves it from.
 */
await page.route('**/*', async (route) => {
  const { pathname } = new URL(route.request().url());
  if (pathname === '/') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  try {
    await route.fulfill({
      status: 200,
      contentType: pathname.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream',
      body: await readFile(path.resolve(`public${pathname}`)),
    });
  } catch {
    await route.fulfill({ status: 404, body: '' });
  }
});
await page.goto('http://market-asset-strip.qa/', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="market-today-assets"]', { timeout: 10_000 });

const measured = await page.evaluate<{
  missing?: boolean;
  stripScrollWidth: number;
  stripClientWidth: number;
  documentOverflows: boolean;
  cells: {
    symbol: string; height: number; width: number; tag: string; name: string;
    nameTruncated: boolean; nameScrollWidth: number; nameClientWidth: number;
    hasLogo: boolean; sparkHeight: number | null; classes: string;
  }[];
}>(`(${PROBE})()`);

if (measured.missing) {
  await browser.close();
  throw new Error('the asset band did not render');
}

const strip = await page.locator('[data-testid="market-today-assets"]');
await strip.screenshot({ path: path.join(OUT, `strip-${WIDTH}-${LABEL}.png`) });
await page.screenshot({ path: path.join(OUT, `page-${WIDTH}-${LABEL}.png`), fullPage: true });
await browser.close();

const tallest = Math.max(...measured.cells.map((cell) => cell.height));
const truncated = measured.cells.filter((cell) => cell.nameTruncated);
const banned = measured.cells.filter((cell) =>
  /\brounded-2xl\b|\bborder\b|\bshadow-/.test(cell.classes));

const report = {
  label: LABEL,
  viewport: WIDTH,
  tallestCell: tallest,
  cells: measured.cells.map(({ classes: _classes, ...rest }) => rest),
  stripScrollsSideways: measured.stripScrollWidth > measured.stripClientWidth,
  documentOverflows: measured.documentOverflows,
  cellsStyledAsCards: banned.map((cell) => cell.symbol),
};
writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2), 'utf8');

console.log(`ASSET BAND · ${WIDTH}px · ${LABEL}`);
console.log(`  tallest cell : ${tallest}px`);
for (const cell of measured.cells) {
  console.log(
    `  ${cell.symbol.padEnd(9)} h=${String(cell.height).padEnd(6)} w=${String(cell.width).padEnd(6)}`,
    `logo=${cell.hasLogo ? 'yes' : 'no '}`,
    `spark=${cell.sparkHeight === null ? '—   ' : `${cell.sparkHeight}px`}`,
    `name="${cell.name}" ${cell.nameWidth}px in ${cell.nameRoom}px${cell.nameTruncated ? ' TRUNCATED' : ''}`,
  );
}
console.log(`  strip scrolls sideways : ${report.stripScrollsSideways}`);
console.log(`  document overflows     : ${report.documentOverflows}`);
if (banned.length) console.log(`  CELLS STYLED AS CARDS  : ${banned.map((c) => c.symbol).join(', ')}`);
console.log(`  artifacts in ${OUT}`);
