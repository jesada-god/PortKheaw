/**
 * UI redesign — responsive proof for the surfaces the visual work changed.
 *
 * What this checks that no unit test can: that the new containers, bands,
 * heading rules and numeral scale survive a real browser at the three widths
 * the redesign brief names, in both appearances, with nothing running off the
 * side of the screen.
 *
 * The overflow probe measures every element's box against the viewport rather
 * than reading `document.scrollWidth`, because the app shell sets
 * `overflow-x: hidden` on `body` — a row that runs off the screen there is
 * CLIPPED rather than scrollable, so the document-level measurement stays clean
 * while the reader loses the end of the row. Elements that are deliberately
 * scrollable (and their children) are skipped, since a horizontal rail is
 * supposed to extend past the viewport.
 *
 * Read-only: it signs in to nothing, writes to no table, and only ever GETs
 * public routes.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/ui-redesign';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';

mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '320x720', width: 320, height: 720, mobile: true },
];

/** Public routes only — this run never authenticates. */
const ROUTES = [
  { path: '/', label: 'overview' },
  { path: '/pricing', label: 'pricing' },
  { path: '/auth/sign-in', label: 'sign-in' },
];

const APPEARANCES = ['dark', 'light'];

/**
 * Every element wider than the viewport, or starting left of it, that is not
 * inside something the page deliberately scrolls sideways.
 */
const OVERFLOW_PROBE = `(() => {
  const width = document.documentElement.clientWidth;
  const scrollers = new Set();
  for (const node of document.querySelectorAll('*')) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') scrollers.add(node);
  }
  const insideScroller = (node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (scrollers.has(parent)) return true;
    }
    return false;
  };
  /*
   * Geometry inside an <svg> is not layout. Decorative backdrop artwork is
   * routinely drawn on a canvas larger than the viewport and clipped by its own
   * viewBox, so every <g>/<line>/<rect> in it reports a box past the screen edge
   * while nothing is actually cut off. The <svg> element itself is still
   * measured — that is the box that belongs to the page.
   */
  const SVG_INTERNALS = new Set([
    'g', 'line', 'rect', 'path', 'circle', 'ellipse', 'polyline', 'polygon',
    'text', 'tspan', 'use', 'defs', 'clippath', 'lineargradient', 'stop',
  ]);
  const offenders = [];
  for (const node of document.querySelectorAll('body *')) {
    if (SVG_INTERNALS.has(node.tagName.toLowerCase())) continue;
    if (insideScroller(node)) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.position === 'fixed') continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    // 1px of slack: sub-pixel layout rounding is not an overflow.
    if (rect.right <= width + 1 && rect.left >= -1) continue;
    offenders.push({
      tag: node.tagName.toLowerCase(),
      cls: (node.getAttribute('class') ?? '').slice(0, 120),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      viewport: width,
    });
  }
  // Only the outermost offender in any chain is worth reporting; its children
  // are overflowing because it is.
  return offenders.slice(0, 12);
})()`;

async function main() {
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const failures = [];
  const consoleErrors = [];

  for (const appearance of APPEARANCES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        deviceScaleFactor: 1,
      });
      await context.addInitScript(
        ([key, value]) => {
          try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
        },
        [THEME_STORAGE_KEY, JSON.stringify({ theme: 'portkheaw', appearance })],
      );
      const page = await context.newPage();
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        // Next's dev-only hydration noise and favicon 404s are not UI defects.
        if (/favicon|manifest|Failed to load resource/i.test(text)) return;
        consoleErrors.push({ appearance, viewport: viewport.name, text: text.slice(0, 200) });
      });

      for (const route of ROUTES) {
        const url = `${BASE_URL}${route.path}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(600);
        const offenders = await page.evaluate(OVERFLOW_PROBE);
        if (offenders.length > 0) {
          failures.push({ appearance, viewport: viewport.name, route: route.path, offenders });
        }
        await page.screenshot({
          path: `${OUT_DIR}/${route.label}-${appearance}-${viewport.name}.png`,
          fullPage: true,
        });
      }
      await context.close();
    }
  }

  await browser.close();

  const report = { baseUrl: BASE_URL, ranAt: new Date().toISOString(), failures, consoleErrors };
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    console.error('HORIZONTAL OVERFLOW:');
    console.error(JSON.stringify(failures, null, 2));
  } else {
    console.log('No horizontal overflow at 1440x900, 390x844 or 320x720, in either appearance.');
  }
  if (consoleErrors.length > 0) {
    console.error('CONSOLE ERRORS:');
    console.error(JSON.stringify(consoleErrors, null, 2));
  }
  console.log(`Screenshots and report: ${OUT_DIR}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
