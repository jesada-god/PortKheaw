/**
 * OVERVIEW PHASE 2 — 375px capture and the flag-cost gate.
 *
 * ===========================================================================
 * WHY THIS IS A SCRIPT AND NOT A TEST
 * ===========================================================================
 * Everything it checks needs a LAYOUT ENGINE and a live page: whether the market
 * band overflows its scroller at 375px, whether a section left a gap behind, and
 * how long the Overview actually takes to render with the Phase 2 flags on
 * versus off. jsdom has no layout and vitest has no server, so neither can
 * answer any of it.
 *
 * ===========================================================================
 * THE GATE
 * ===========================================================================
 * `--baseline` and `--candidate` are two running deployments — the same build,
 * one with `PHASE2_*` unset and one with them set to `true`. The script times
 * the Overview document on both and FAILS (exit 1) when the candidate is more
 * than `--max-ratio` (default 2) times the baseline. That is the release gate:
 * over it, the flags do not get turned on.
 *
 * Timing is the SERVER document, not a browser paint. The flags decide what the
 * server loads — six quotes, a capped watchlist view, one alert read — and a
 * paint measurement would fold in hydration and network noise that the flags do
 * not control. Samples are taken after a warm-up request, and the median is
 * reported alongside the spread so one slow sample cannot decide a release.
 *
 * ===========================================================================
 * USAGE
 * ===========================================================================
 *   # one deployment, screenshots only
 *   node scripts/qa/overview-phase2-qa.mjs --candidate http://localhost:3311
 *
 *   # both, with the cost gate
 *   node scripts/qa/overview-phase2-qa.mjs \
 *     --baseline http://localhost:3310 --candidate http://localhost:3311
 *
 * A signed-in run needs a storage state captured by `scripts/qa/capture-auth-state.mjs`,
 * passed with `--auth <path>`; without it the run is the signed-out Overview,
 * which still exercises the market band, the events list and the news feed.
 *
 * NOTE: this has never been run against a live page. The environment it was
 * written in has `maintenance_enabled = true`, so `/` answers 307 to
 * `/maintenance` for every non-admin request. Turning that off is a write to
 * shared state and was not this change's to make.
 */

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CANDIDATE = arg('candidate', 'http://localhost:3000');
const BASELINE = arg('baseline');
const AUTH = arg('auth');
const OUT = resolve(arg('out', '.qa/artifacts/overview-phase2'));
const SAMPLES = Number(arg('samples', '7'));
const MAX_RATIO = Number(arg('max-ratio', '2'));

mkdirSync(OUT, { recursive: true });

/**
 * Every section, and the marker only that section draws.
 *
 * A section that is off must leave NOTHING behind — not an empty panel, not a
 * wrapper holding a margin open — so absence is checked as "the marker is not
 * in the DOM", not as "the marker is invisible".
 */
const SECTIONS = [
  ['marketToday', '#market-overview'],
  ['portfolio', '[data-testid="overview-portfolio-line"]'],
  ['whatChanged', '[data-testid="overview-changes"]'],
  ['watchlist', '[data-testid="overview-watchlist"]'],
  ['events', '[data-testid="overview-events"]'],
  ['news', '[data-testid="overview-news"]'],
];

/** The states each section can be caught in, by the element that proves it. */
const STATE_MARKERS = [
  ['marketToday.strip', '[data-testid="market-today-strip"]'],
  ['marketToday.status', '[data-testid="market-today-status"]'],
  ['marketToday.reasons', '[data-testid="market-today-reasons"]'],
  ['marketToday.stale', '[data-testid="market-today-stale"]'],
  ['marketToday.assets', '[data-testid="market-today-assets"]'],
  ['whatChanged.rows', '[data-testid="overview-changes-list"]'],
  ['whatChanged.empty', '[data-testid="overview-changes-empty"]'],
  ['watchlist.table', '[data-testid="overview-watchlist-table"]'],
  ['watchlist.trend', '[data-testid^="overview-watchlist-trend-"]'],
  ['watchlist.alerts', '[data-testid^="overview-watchlist-alerts-"]'],
  ['events.rows', '[data-testid^="overview-event-"]'],
  ['events.empty', '[data-testid="overview-events-empty"]'],
  ['events.coverage', '[data-testid="overview-events-coverage"]'],
  ['news.tabs', '[data-testid="news-scope-filter"]'],
  ['news.empty', '[data-testid="news-scope-empty"]'],
  ['loading.skeleton', '[role="status"]'],
];

/** Median, because one slow sample must not decide a release. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * How long the SERVER takes to produce the Overview document.
 *
 * One warm-up first: a cold Next.js route compiles on the first request in dev
 * and that number describes the bundler, not the page.
 */
async function timeDocument(base, samples) {
  const url = new URL('/', base).toString();
  const durations = [];
  await fetch(url, { redirect: 'manual' }).catch(() => null);
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { redirect: 'manual' });
    await response.arrayBuffer();
    durations.push(performance.now() - started);
    if (response.status !== 200) {
      return { url, status: response.status, durations: [], median: null,
        note: `expected 200, got ${response.status}${response.headers.get('location')
          ? ` -> ${response.headers.get('location')}` : ''}` };
    }
  }
  return {
    url,
    status: 200,
    durations: durations.map((value) => Math.round(value)),
    median: Math.round(median(durations)),
    note: null,
  };
}

async function capture(browser, base, label) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    ...(AUTH ? { storageState: AUTH } : {}),
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const response = await page.goto(new URL('/', base).toString(), {
    waitUntil: 'networkidle',
    timeout: 120_000,
  });

  const report = { label, base, status: response?.status() ?? null, errors };

  if ((response?.status() ?? 0) !== 200) {
    report.note = `page did not render: ${page.url()}`;
    await context.close();
    return report;
  }

  report.order = await page.evaluate((markers) => {
    const all = [...document.querySelectorAll('*')];
    return markers
      .map(([key, selector]) => {
        const node = document.querySelector(selector);
        return node ? { key, position: all.indexOf(node) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.position - b.position)
      .map((item) => item.key);
  }, SECTIONS);

  report.states = await page.evaluate((markers) => Object.fromEntries(
    markers.map(([key, selector]) => [key, document.querySelectorAll(selector).length]),
  ), STATE_MARKERS);

  /*
    A horizontal scroller inside the page is intended — the market band is one.
    The PAGE scrolling sideways is the defect, so offenders inside a declared
    scroller are excluded and everything else is reported.
  */
  report.overflow = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    offenders: [...document.querySelectorAll('main *')]
      .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((node) => !node.closest('.data-strip-scroll, .bleed-mobile, [class*="overflow-x-auto"]'))
      .slice(0, 8)
      .map((node) => `${node.tagName}.${String(node.className).slice(0, 70)}`),
  }));

  /* Every section screenshotted on its own, so a diff names the section. */
  for (const [key, selector] of SECTIONS) {
    const node = await page.$(selector);
    if (!node) continue;
    await node.screenshot({ path: `${OUT}/${label}-${key}-375.png` }).catch(() => {});
  }
  await page.screenshot({ path: `${OUT}/${label}-full-375.png`, fullPage: true });

  await context.close();
  return report;
}

const report = { generatedAt: new Date().toISOString(), maxRatio: MAX_RATIO };

report.timing = { candidate: await timeDocument(CANDIDATE, SAMPLES) };
if (BASELINE) report.timing.baseline = await timeDocument(BASELINE, SAMPLES);

if (report.timing.baseline?.median && report.timing.candidate?.median) {
  const ratio = report.timing.candidate.median / report.timing.baseline.median;
  report.timing.ratio = Number(ratio.toFixed(2));
  report.timing.withinGate = ratio <= MAX_RATIO;
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
try {
  report.candidate = await capture(browser, CANDIDATE, 'candidate');
  if (BASELINE) report.baseline = await capture(browser, BASELINE, 'baseline');
} finally {
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (report.candidate?.status !== 200) failures.push('the Overview did not render');
if (report.candidate?.overflow?.offenders?.length) failures.push('the page scrolls sideways at 375px');
if (report.timing.withinGate === false) {
  failures.push(`flags on is ${report.timing.ratio}x baseline, over the ${MAX_RATIO}x gate`);
}
if (failures.length) {
  console.error(`\nFAILED: ${failures.join(' · ')}`);
  process.exit(1);
}
