/**
 * THE CALENDAR GRID IN BOTH THEMES, AT BOTH WIDTHS, BEFORE AND AFTER.
 *
 * ===========================================================================
 * WHAT THIS EXISTS TO SETTLE
 * ===========================================================================
 * Four changes to `/market-events` are all claims about pixels, and three of
 * them are claims about COLOUR:
 *
 *   1. the day panel and the feed no longer draw the same day twice;
 *   2. the cells are separated by a rule rather than by air;
 *   3. a day with releases carries a wash of its highest importance;
 *   4. the weekday headings read as a different layer from the dates.
 *
 * A wash that is legible on the near-black surface can be invisible on the
 * white one, and a rule that separates cells in dark can disappear in light.
 * So every capture is taken twice, once per appearance, and the contrast of
 * the day number against whatever is now behind it is COMPUTED rather than
 * eyeballed — `contrastRatio` below is WCAG's own formula, applied to the
 * colours the browser actually resolved.
 *
 * ===========================================================================
 * HOW "BEFORE" IS OBTAINED
 * ===========================================================================
 * `--state before` renders the feed WITHOUT the split, which is exactly the
 * wiring the page had, and it must be run before the component changes land.
 * The captures it writes are kept and compared against `--state after`; the
 * grid's own before/after is the difference between the two runs of this file,
 * which is why the artefacts carry the state in their names rather than being
 * overwritten.
 *
 * ===========================================================================
 * THE HEIGHT BUDGET
 * ===========================================================================
 * Change 4 adds separation between the headings and the first row, and
 * separation costs height on the one screen that cannot afford it. The grid
 * must stay inside 1.2x of what it was and the whole month must stay visible
 * at 375px without scrolling, so both are measured and both fail the run.
 *
 * Run: npm run qa:events-calendar-theme -- --state before
 *      npm run qa:events-calendar-theme -- --state after
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MonthCalendar } from '@/src/components/market-events/MonthCalendar';
import { MarketEventsCard } from '@/src/components/market-events/MarketEventsCard';
import { MarketEventsFeed } from '@/src/components/market-events/MarketEventsFeed';
import { buildEventFeed, exposureNoteTh, splitFeedForPanel } from '@/src/lib/market-events/feed';
import { buildMarketEventsMonthView } from '@/src/lib/market-events/month-view';
import { buildMarketEventsCardView } from '@/src/lib/market-events/card-view';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback);
const STATE = flag('state', 'after');
/**
 * Which recorded run the height budget is measured against.
 *
 * It defaults to the ORIGINAL `before` — the calendar as it was before any of
 * this work — rather than to the previous round. A ceiling that moves up every
 * time the grid grows a little is not a ceiling; anchoring it to the state the
 * reporter first complained about is what keeps 1.20x meaning the same thing in
 * round three as it did in round one.
 */
const BASELINE = flag('baseline', 'before');
const OUT_DIR = '.qa/artifacts/market-events-calendar-theme';

/**
 * A day the reporter was actually looking at: the panel opens on it, the feed
 * starts on it, and it carries a high-importance release — so the duplicate
 * being removed is visible, and so is the wash the cell now takes.
 */
const NOW = '2026-09-04T04:00:00.000Z';
const HOLDINGS = 6;
const WIDTHS = [
  { label: '375', width: 375 },
  { label: 'desktop', width: 1280 },
];
const APPEARANCES = ['dark', 'light'];

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/** The page column as `app/market-events/page.tsx` builds it, minus the header. */
function column(children: string): string {
  return '<main class="mx-auto w-full max-w-[1440px] px-[var(--page-gutter)] py-4">'
    + '<div class="mx-auto w-full max-w-3xl space-y-4">'
    + children
    + '</div></main>';
}

/**
 * THE TWO SURFACES THAT DRAW A MONTH, captured side by side.
 *
 * `MonthCalendar` is the calendar page and `MarketEventsCard` is the block on
 * the Overview. They are two components on purpose — `month-view.ts` builds a
 * walkable month with a selected day, `card-view.ts` builds a read-only one and
 * keeps the calendar JSON out of the client bundle — and nothing here merges
 * them. What this run is for is checking they LOOK like the same calendar,
 * which is a different question from whether they share a builder.
 */
function calendarPageMarkup(): string {
  const view = buildMarketEventsMonthView({ now: NOW });
  if (!view) throw new Error('the month view should build for a fixed instant');

  const all = buildEventFeed({ now: NOW });
  /*
    The original `before` is the wiring the page had — the panel shows the
    selected day and the feed shows it again. Every later state is the wiring
    it has now.
  */
  const split = STATE === 'before'
    ? { days: all, hiddenDayKey: null }
    : splitFeedForPanel({ days: all, panelDayKey: view.selected?.dayKey ?? null });

  return column(
    renderToString(React.createElement(MonthCalendar, { view }))
    + renderToString(React.createElement(MarketEventsFeed, {
      days: split.days,
      hiddenDayKey: split.hiddenDayKey,
      exposureNoteTh: exposureNoteTh(HOLDINGS),
    })),
  );
}

/** The Overview's own column, so the card is measured at the width it gets. */
function overviewMarkup(): string {
  const view = buildMarketEventsCardView({ now: NOW });
  if (!view) throw new Error('the card view should build for a fixed instant');
  return '<main class="mx-auto w-full max-w-[1440px] px-[var(--page-gutter)] py-4">'
    + renderToString(React.createElement(MarketEventsCard, { view }))
    + '</main>';
}

const SURFACES = [
  { key: 'calendar', prefix: '', markup: calendarPageMarkup, shot: '[data-testid="market-events-calendar"]' },
  { key: 'overview', prefix: 'overview-', markup: overviewMarkup, shot: '[data-testid="market-events-card"]' },
];

/**
 * Everything the four changes are answerable for, read off the live box model
 * and the resolved colours.
 *
 * The contrast numbers are the point: a wash is only allowed if the day number
 * on top of it still reads, and "still reads" is a ratio, not an impression.
 */
const PROBE = String.raw`() => {
  const rgb = (value) => {
    const parts = value.match(/[\d.]+/g);
    if (!parts) return null;
    return [Number(parts[0]), Number(parts[1]), Number(parts[2]),
      parts.length > 3 ? Number(parts[3]) : 1];
  };
  const over = (top, bottom) => {
    if (!top || !bottom) return bottom || top;
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const luminance = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrastRatio = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  /* Whichever of the two is on the page — they are never both. */
  const calendar = document.querySelector('[data-testid="market-events-calendar"]')
    || document.querySelector('[data-testid="market-events-card"]');
  const pageBg = rgb(getComputedStyle(document.body).backgroundColor);

  const cells = [...document.querySelectorAll('[data-testid^="market-events-cell-2"]')];
  /*
    FOUND STRUCTURALLY, NOT BY A TEST ID, so the same thing is measured before
    and after: a marker added by the change would make the two runs measure two
    different boxes and the height budget would compare nothing to nothing.
    The cells' own parent is the seven-column grid; the row above it is the
    weekday headings, in both versions of this markup.
  */
  const cellGrid = cells.length ? cells[0].parentElement : null;
  const headings = cellGrid ? cellGrid.previousElementSibling : null;
  const gridTop = headings
    ? headings.getBoundingClientRect().top
    : (cellGrid ? cellGrid.getBoundingClientRect().top : null);
  const gridBottom = cellGrid ? cellGrid.getBoundingClientRect().bottom : null;
  const surface = (calendar
    ? rgb(getComputedStyle(calendar).backgroundColor)
    : null) || pageBg;

  /*
    EVERY LAYER, IN ORDER, because the wash is translucent and so is the
    number's own disc. Reading one element's computed backgroundColor and
    calling it "the background" is how a wash gets reported as the surface it
    is sitting on. The stack is: panel surface, then the cell's own
    opaque background, then the wash box that fills it, then the disc under
    today's number if there is one.

    Both pieces of text on the cell are measured — the day number, and the
    release name the desktop layout prints — because a wash that keeps the
    number readable can still swallow the name.
  */
  const textOn = (el, behind) => {
    if (!el) return null;
    const own = rgb(getComputedStyle(el).backgroundColor);
    const bg = own && own[3] > 0 ? over(own, behind) : behind;
    return contrastRatio(over(rgb(getComputedStyle(el).color), bg), bg);
  };

  const cellReport = cells.map((cell) => {
    const washBox = cell.firstElementChild;
    let behind = over(rgb(getComputedStyle(cell).backgroundColor), surface);
    const washColour = washBox ? getComputedStyle(washBox).backgroundColor : null;
    if (washBox) behind = over(rgb(washColour), behind);

    const numberContrast = textOn(cell.querySelector('[data-day-number]'), behind);
    const nameContrast = textOn(cell.querySelector('[data-day-name]'), behind);
    const both = [numberContrast, nameContrast].filter((value) => value !== null);

    return {
      day: cell.getAttribute('data-testid').replace('market-events-cell-', ''),
      importance: cell.getAttribute('data-importance'),
      today: cell.getAttribute('data-today') === 'true',
      background: washColour,
      numberContrast,
      nameContrast,
      contrast: both.length ? Math.min.apply(null, both) : null,
      ariaLabel: cell.getAttribute('aria-label'),
    };
  });

  return {
    calendarHeight: calendar ? Math.round(calendar.getBoundingClientRect().height) : null,
    /* Headings row through the last week — "ความสูงตารางรวม". */
    gridHeight: gridTop === null || gridBottom === null
      ? null
      : Math.round(gridBottom - gridTop),
    headingGap: headings && cells.length
      ? Math.round(cells[0].getBoundingClientRect().top - headings.getBoundingClientRect().bottom)
      : null,
    headingFontSize: headings && headings.firstElementChild
      ? getComputedStyle(headings.firstElementChild).fontSize
      : null,
    headingColor: headings && headings.firstElementChild
      ? getComputedStyle(headings.firstElementChild).color
      : null,
    headingsBorderBottom: headings
      ? getComputedStyle(headings).borderBottomWidth + ' ' + getComputedStyle(headings).borderBottomColor
      : null,
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    /* The whole month visible without scrolling the calendar itself. */
    calendarScrolls: calendar
      ? calendar.scrollHeight > calendar.clientHeight + 1
        || calendar.scrollWidth > calendar.clientWidth + 1
      : false,
    cells: cellReport,
    /* Change 1: the panel's day must not appear as a feed section as well. */
    panelDay: (document.querySelector('[data-testid="market-events-day-panel"] h3') || {}).textContent || null,
    feedDayIds: [...document.querySelectorAll('[data-testid^="market-events-day-2"]')]
      .map((el) => el.id),
    feedEmptyText: (document.querySelector('[data-testid="market-events-feed-empty"]') || {}).textContent || null,
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

const report: Record<string, unknown>[] = [];
let failures = 0;

for (const surface of SURFACES) {
  const html = surface.markup();
  for (const appearance of APPEARANCES) {
    for (const size of WIDTHS) {
    const page = await browser.newPage({
      viewport: { width: size.width, height: 1400 },
      deviceScaleFactor: 2,
    });
    const doc = `<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="${appearance}">`
      + `<head><meta charset="utf-8"><style>${css}</style></head>`
      + `<body style="background:var(--bg)">${html}</body></html>`;
    await page.route('**/*', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: doc });
        return;
      }
      await route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://localhost/', { waitUntil: 'networkidle' });

    const measured = await page.evaluate(`(${PROBE})()`) as Record<string, any>;
    /*
      The calendar surface keeps its bare name so the original `before-report`
      still lines up with it; only the surface added later takes a prefix.
    */
    const name = `${surface.prefix}${size.label}-${appearance}-${STATE}`;
    await page.locator(surface.shot)
      .screenshot({ path: path.join(OUT, `${name}-calendar.png`) });
    await page.screenshot({ path: path.join(OUT, `${name}-page.png`), fullPage: true });
    await page.close();

    const worst = measured.cells.reduce(
      (low: any, cell: any) => (cell.contrast === null
        ? low
        : (low === null || cell.contrast < low.contrast ? cell : low)),
      null,
    );
    const washed = measured.cells.filter((cell: any) => cell.importance);

    console.log(`\n${name}`);
    console.log(`  calendar ${measured.calendarHeight}px · grid ${measured.gridHeight}px`
      + ` · headings→first row gap ${measured.headingGap}px`
      + ` · heading ${measured.headingFontSize} ${measured.headingColor}`);
    console.log(`  headings rule: ${measured.headingsBorderBottom}`);
    console.log(`  washed cells ${washed.length}/${measured.cells.length}`
      + ` · worst text contrast ${worst ? worst.contrast : '—'}:1`
      + `${worst ? ` (${worst.day}${worst.importance ? `, ${worst.importance}` : ''})` : ''}`);
    console.log(`  panel day: ${measured.panelDay} · feed days: ${measured.feedDayIds.join(', ') || '(none)'}`);
    if (measured.feedEmptyText) console.log(`  feed empty says: ${measured.feedEmptyText.trim()}`);

    /*
      A wash that costs legibility is not a wash, it is a defect. 4.5:1 is the
      WCAG AA threshold for body text and the day number is body text.
    */
    const failing = measured.cells.filter((cell: any) => cell.contrast !== null && cell.contrast < 4.5);
    if (failing.length > 0) {
      console.error(`  FAIL — ${failing.length} cells below 4.5:1`);
      for (const cell of failing.slice(0, 5)) {
        console.error(`    ${cell.day} ${cell.importance ?? 'no event'} — ${cell.contrast}:1 on ${cell.background}`);
      }
      failures += 1;
    }
    /* Change 3 says colour is never the only channel. */
    const mute = measured.cells.filter((cell: any) => cell.importance && !cell.ariaLabel);
    if (mute.length > 0) {
      console.error(`  FAIL — ${mute.length} washed cells carry no aria-label`);
      failures += 1;
    }
    if (measured.documentOverflows) {
      console.error(`  FAIL — the document overflows ${size.width}px`);
      failures += 1;
    }
    if (measured.calendarScrolls) {
      console.error('  FAIL — the calendar has to be scrolled to see the month');
      failures += 1;
    }

    report.push({ name, surface: surface.key, appearance, width: size.width, state: STATE, measured });
    }
  }
}

const reportFile = path.join(OUT, `${STATE}-report.json`);
writeFileSync(reportFile, `${JSON.stringify({ state: STATE, now: NOW, runs: report }, null, 2)}\n`, 'utf8');
await browser.close();

/*
 * THE HEIGHT BUDGET, checked against the recorded `before` run rather than
 * against a number typed into this file — a hardcoded ceiling stops being the
 * real one the first time the grid legitimately changes.
 */
const beforeFile = path.join(OUT, `${BASELINE}-report.json`);
if (STATE !== BASELINE && existsSync(beforeFile)) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8')) as { runs: any[] };
  console.log(`\ngrid height, ${BASELINE} → ${STATE} (budget 1.20x)`);
  for (const run of report as any[]) {
    const previous = before.runs.find(
      (item) => item.name === `${run.name.slice(0, -STATE.length)}${BASELINE}`,
    );
    if (!previous) {
      console.log(`  ${run.name}: no ${BASELINE} run to compare against`);
      continue;
    }
    const from = previous.measured.gridHeight;
    const to = run.measured.gridHeight;
    const ratio = Math.round((to / from) * 1000) / 1000;
    const verdict = ratio > 1.2 ? 'OVER BUDGET' : 'ok';
    console.log(`  ${run.name}: ${from}px → ${to}px = ${ratio}x  ${verdict}`);
    if (ratio > 1.2) failures += 1;
  }
}

console.log(`\nreport: ${reportFile}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
}
