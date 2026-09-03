/**
 * THE CALENDAR PAGE AT 375px, MEASURED AND CAPTURED — BEFORE AND AFTER.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A TEST
 * ===========================================================================
 * `MonthCalendar.test.tsx` proves what is in the DOM and what it links to.
 * Every claim this feature makes about the PHONE is a claim about a box model,
 * and jsdom has none: whether seven columns fit 375 pixels without the document
 * scrolling sideways, whether a cell is a tappable height, whether the marks
 * fit beside each other in fifty pixels, and whether a release name at `sm:`
 * is clipped instead of wrapping the row taller than its neighbours. None of
 * those can fail in a unit test, and all of them can fail on a handset.
 *
 * ===========================================================================
 * BOTH STATES IN ONE RUN
 * ===========================================================================
 * "Before" is the route as it actually was: the feed alone, no grid. "After" is
 * the route as it now is. Rendering both here rather than asking somebody to
 * check out the parent commit means the pair is reproducible by anybody, at any
 * time, and that the two captures share a stylesheet, a viewport and a clock —
 * which is what makes them comparable at all.
 *
 * A third capture, `uncovered`, is the empty-month claim. It is the state most
 * likely to be got wrong later and the least likely to be looked at: a month
 * past the end of the file must read as "this calendar does not reach here",
 * never as a correctly drawn month in which nothing is scheduled.
 *
 * ===========================================================================
 * IT RENDERS THE SHIPPED CALENDAR
 * ===========================================================================
 * The fixture is `market-events.json` itself, through the real view builders —
 * not a hand-written view. So the dates, the Thai labels, the mark counts and
 * the ordering are the ones the product computes.
 *
 * The clock is 25 November 2026, deliberately: it is the densest day in the
 * shipped file — three releases, because DOL moves that week's claims report
 * off Thursday for Thanksgiving — so the capture shows the worst case a cell
 * and the panel have to survive rather than a typical one.
 *
 * Run: npm run qa:events-calendar
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MonthCalendar } from '@/src/components/market-events/MonthCalendar';
import { MarketEventsFeed } from '@/src/components/market-events/MarketEventsFeed';
import { buildEventFeed, exposureNoteTh } from '@/src/lib/market-events/feed';
import { buildMarketEventsMonthView } from '@/src/lib/market-events/month-view';
import type { ReactionRow } from '@/src/lib/market-events/reactions';
import type { ReleaseTiming } from '@/src/lib/market-events/release-timing';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const WIDTH = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 375;
const OUT_DIR = '.qa/artifacts/market-events-calendar';

/** The densest day the shipped file has: three releases on 25 November 2026. */
const NOW = '2026-11-25T04:00:00.000Z';
/** A month past the last row in the file, whatever the last row currently is. */
const UNCOVERED_MONTH = '2027-03';
const HOLDINGS = 6;

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/**
 * The page column as `app/market-events/page.tsx` builds it, minus the header.
 *
 * `renderToString`, not `renderToStaticMarkup`: this markup is what the server
 * sends and the browser hydrates over, so the captured DOM should be that one.
 */
function column(children: string): string {
  return '<main class="mx-auto w-full max-w-[1440px] px-[var(--page-gutter)] py-4">'
    + '<div class="mx-auto w-full max-w-3xl space-y-4">'
    + children
    + '</div></main>';
}

/*
 * Reaction history, as a FIXTURE, and the only reason the block can be captured
 * at all: `market-event-reactions.json` is empty because no past release has
 * been transcribed into the calendar yet. Not one of these session dates is
 * offered as a real publication date. They exist so the 375px behaviour of a
 * three-number block under a row that already carries a time, a title, a source
 * and an importance chip is measured BEFORE somebody backfills a hundred
 * releases and finds out. See docs/market-events-backfill.md.
 */
const REACTIONS: Record<ReleaseTiming, ReactionRow[]> = {
  beforeOpen: [
    { eventId: 'qa-1', kind: 'PCE', sessionDate: '2026-08-28', previousSessionDate: '2026-08-27', close: 100, previousClose: 99.58, changePercent: 0.42 },
    { eventId: 'qa-2', kind: 'PCE', sessionDate: '2026-07-31', previousSessionDate: '2026-07-30', close: 100, previousClose: 101.11, changePercent: -1.1 },
    { eventId: 'qa-3', kind: 'PCE', sessionDate: '2026-06-26', previousSessionDate: '2026-06-25', close: 100, previousClose: 99.8, changePercent: 0.2 },
    { eventId: 'qa-4', kind: 'GDP', sessionDate: '2026-08-27', previousSessionDate: '2026-08-26', close: 100, previousClose: 100.31, changePercent: -0.31 },
    { eventId: 'qa-5', kind: 'GDP', sessionDate: '2026-07-30', previousSessionDate: '2026-07-29', close: 100, previousClose: 98.85, changePercent: 1.16 },
    { eventId: 'qa-6', kind: 'JOBLESS_CLAIMS', sessionDate: '2026-11-19', previousSessionDate: '2026-11-18', close: 100, previousClose: 99.93, changePercent: 0.07 },
  ],
  intraday: [],
  afterClose: [],
};

function calendarMarkup(
  monthParam?: string,
  reactionBuckets?: Record<ReleaseTiming, ReactionRow[]>,
): string {
  const view = buildMarketEventsMonthView({ now: NOW, monthParam, reactionBuckets });
  if (!view) throw new Error('the month view should build for a fixed instant');
  return renderToString(React.createElement(MonthCalendar, { view }));
}

function feedMarkup(): string {
  return renderToString(React.createElement(MarketEventsFeed, {
    days: buildEventFeed({ now: NOW }),
    exposureNoteTh: exposureNoteTh(HOLDINGS),
  }));
}

const STATES: Array<{ label: string; body: string; anchor: string }> = [
  {
    label: 'before',
    // The route as it was: the feed, and nothing to walk.
    body: column(feedMarkup()),
    anchor: '[data-testid="market-events-feed"]',
  },
  {
    label: 'after',
    body: column(calendarMarkup() + feedMarkup()),
    anchor: '[data-testid="market-events-calendar"]',
  },
  {
    label: 'after-uncovered',
    body: column(calendarMarkup(UNCOVERED_MONTH) + feedMarkup()),
    anchor: '[data-testid="market-events-calendar"]',
  },
  /*
    The history block, which cannot appear from the shipped data at all. The
    day being captured carries three releases, two of which have fixture
    history, so this also measures what a row looks like when the one beside it
    has none — the block must be absent there rather than reserved.
  */
  {
    label: 'after-reactions',
    body: column(calendarMarkup(undefined, REACTIONS) + feedMarkup()),
    anchor: '[data-testid="market-events-calendar"]',
  },
];

/**
 * Read the page the way a thumb meets it.
 *
 * The cell box is measured rather than described: a 44px minimum is the whole
 * reason the page cell is taller than the card cell, and a class name in the
 * source proves nothing about what the browser laid out.
 */
const PROBE = `() => {
  const calendar = document.querySelector('[data-testid="market-events-calendar"]');
  const cells = [...document.querySelectorAll('[data-testid^="market-events-cell-2"]')]
    .map((node) => {
      const box = node.getBoundingClientRect();
      return {
        day: node.getAttribute('data-testid').replace('market-events-cell-', ''),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        marks: node.querySelectorAll('[aria-hidden="true"] > span').length,
        label: node.getAttribute('aria-label'),
        tappable: node.tagName === 'A',
        selected: node.getAttribute('data-selected') === 'true',
        today: node.getAttribute('data-today') === 'true',
        clipped: node.scrollWidth > node.clientWidth + 1,
      };
    });
  const panel = document.querySelector('[data-testid="market-events-day-panel"]');
  const step = (which) => {
    const node = document.querySelector('[data-testid="market-events-' + which + '-month"]');
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      tag: node.tagName,
      disabled: node.disabled === true,
      href: node.getAttribute('href'),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  };
  return {
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    calendarHeight: calendar ? Math.round(calendar.getBoundingClientRect().height) : null,
    pageHeight: Math.round(document.body.getBoundingClientRect().height),
    month: (document.querySelector('[data-testid="market-events-month"]') || {}).textContent || null,
    monthTotal: (document.querySelector('[data-testid="market-events-month-total"]') || {}).textContent || null,
    coverage: (document.querySelector('[data-testid="market-events-coverage"]') || {}).textContent || null,
    legend: (document.querySelector('[data-testid="market-events-legend"]') || {}).innerText
      ? document.querySelector('[data-testid="market-events-legend"]').innerText.replace(/\\s+/g, ' ').trim()
      : null,
    prev: step('prev'),
    next: step('next'),
    cellCount: cells.length,
    /* The tightest and the busiest cells are the ones that fail first. */
    minCellWidth: cells.length ? Math.min(...cells.map((c) => c.width)) : null,
    minCellHeight: cells.length ? Math.min(...cells.map((c) => c.height)) : null,
    maxMarks: cells.length ? Math.max(...cells.map((c) => c.marks)) : null,
    clippedCells: cells.filter((c) => c.clipped).map((c) => c.day),
    busiest: cells.filter((c) => c.marks > 1),
    marked: cells.filter((c) => c.marks > 0).map((c) => c.day + '×' + c.marks),
    selected: cells.filter((c) => c.selected).map((c) => c.day),
    today: cells.filter((c) => c.today).map((c) => c.day),
    untappable: cells.filter((c) => !c.tappable).length,
    panel: panel ? {
      heading: panel.innerText.split('\\n')[0],
      rows: [...panel.querySelectorAll('li')]
        .map((li) => li.innerText.replace(/\\s+/g, ' ').trim()),
      overflows: [...panel.querySelectorAll('li')]
        .filter((li) => li.scrollWidth > li.clientWidth + 1).length,
    } : null,
    reactions: [...document.querySelectorAll('[data-testid*="-reaction-"]')].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        testId: node.getAttribute('data-testid'),
        text: node.innerText.replace(/\\s+/g, ' ').trim(),
        height: Math.round(box.height),
        overflows: node.scrollWidth > node.clientWidth + 1,
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

const report: Record<string, unknown> = { viewport: WIDTH, now: NOW };

for (const state of STATES) {
  const html = '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
    + `<head><meta charset="utf-8"><style>${css}</style></head>`
    + `<body style="background:var(--bg)">${state.body}</body></html>`;

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 1200 },
    deviceScaleFactor: 2,
  });
  await page.route('**/*', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://market-events.qa/', { waitUntil: 'load' });
  await page.waitForSelector(state.anchor, { timeout: 10_000 });

  const measured = await page.evaluate(`(${PROBE})()`) as Record<string, unknown>;
  await page.locator(state.anchor)
    .screenshot({ path: path.join(OUT, `calendar-${WIDTH}-${state.label}.png`) });
  await page.screenshot({
    path: path.join(OUT, `page-${WIDTH}-${state.label}.png`),
    fullPage: true,
  });
  await page.close();

  report[state.label] = measured;

  const cell = (key: string) => measured[key];
  console.log(`\nCALENDAR · ${WIDTH}px · ${state.label}`);
  console.log(`  month            : ${cell('month') ?? '(no grid)'} ${cell('monthTotal') ?? ''}`);
  console.log(`  coverage note    : ${cell('coverage') ?? '(none)'}`);
  console.log(`  document overflows : ${cell('documentOverflows')}`);
  console.log(`  calendar height  : ${cell('calendarHeight') ?? '(none)'}px   page ${cell('pageHeight')}px`);
  if (cell('cellCount')) {
    console.log(`  cells            : ${cell('cellCount')}  min ${cell('minCellWidth')}×${cell('minCellHeight')}px  untappable ${cell('untappable')}`);
    console.log(`  marks            : max ${cell('maxMarks')} on a day · ${(cell('marked') as string[]).join(' ')}`);
    console.log(`  clipped cells    : ${(cell('clippedCells') as string[]).length ? (cell('clippedCells') as string[]).join(' ') : 'none'}`);
    console.log(`  today / selected : ${(cell('today') as string[]).join(',') || '(none)'} / ${(cell('selected') as string[]).join(',') || '(none)'}`);
    console.log(`  legend           : ${cell('legend') ?? '(none)'}`);
    console.log(`  prev / next      : ${JSON.stringify(cell('prev'))} / ${JSON.stringify(cell('next'))}`);
  }
  const panel = measured.panel as { heading: string; rows: string[]; overflows: number } | null;
  if (panel) {
    console.log(`  panel            : ${panel.heading}  (${panel.rows.length} rows, ${panel.overflows} overflowing)`);
    for (const row of panel.rows) console.log(`      ${row}`);
  } else {
    console.log('  panel            : (none)');
  }
  const reactions = measured.reactions as Array<{ testId: string; text: string; height: number; overflows: boolean }>;
  console.log(`  history blocks   : ${reactions.length}`);
  for (const block of reactions) {
    console.log(`      ${block.text}  [${block.height}px${block.overflows ? ', OVERFLOWS' : ''}]`);
  }
}

await browser.close();
writeFileSync(path.join(OUT, `report-${WIDTH}.json`), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  artifacts in ${OUT}`);
