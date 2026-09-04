/**
 * THE OVERVIEW'S CALENDAR SLOT AT 375px, BEFORE AND AFTER, SIDE BY SIDE.
 *
 * ===========================================================================
 * WHAT CHANGED, AND WHY A PICTURE DECIDES IT
 * ===========================================================================
 * `OVERVIEW_ORDER_V2` used to fill its calendar slot with `events` — the merged
 * list, drawn by `EventsList`. It draws `marketEvents` now, the month grid. The
 * argument for the swap is entirely about what a reader takes in without
 * reading: a grid shows the SHAPE of a month at a glance, a list shows exactly
 * what is coming and whether it touches you. That is a claim about pixels on a
 * handset, so it is settled with pixels on a handset rather than with a test.
 *
 * ===========================================================================
 * ONE DATE, ONE SOURCE FILE, TWO SHAPES
 * ===========================================================================
 * Both halves are built from `src/data/market-events.json` at the same instant,
 * through the product's own builders — `buildOverviewEvents` for the list and
 * `buildMarketEventsCardView` for the grid. Neither view is hand-written, so a
 * difference in the capture is a difference in the rendering and not in the
 * fixture. The list additionally gets the Upcoming feed and a watchlist,
 * because carrying those rows is the thing it does that the grid does not, and
 * a comparison that left them out would flatter the grid.
 *
 * ===========================================================================
 * WHAT IS MEASURED AS WELL AS SHOWN
 * ===========================================================================
 * Height, because "fits above the fold on a handset" is the practical half of
 * the argument. Horizontal overflow, because a calendar that scrolls sideways
 * has lost the property that makes it a calendar. And the day links, because
 * the grid is only an improvement if tapping a day lands on that day — every
 * `href` is read back and checked to carry a month that contains its own day.
 *
 * Run: npm run qa:overview-calendar-slot
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildOverviewEvents } from '@/src/lib/overview/events-feed';
import { buildMarketEventsCardView } from '@/src/lib/market-events/card-view';
import { MARKET_EVENTS } from '@/src/lib/market-events/calendar';
import { EventsList } from '@/src/components/dashboard/EventsList';
import { MarketEventsCard } from '@/src/components/market-events/MarketEventsCard';
import type { OvEventCalendar, OvMarketEvent } from '@/src/lib/market-overview/events';
import type { UpcomingFeed } from '@/src/lib/upcoming/types';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const WIDTH = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 375;
const OUT_DIR = '.qa/artifacts/overview-calendar-slot';

/**
 * A Wednesday inside the calendar's own range, chosen so both halves have
 * something to say: September 2026 carries nine releases and the first of them
 * is the next day, so the list opens with a row and the grid opens with a
 * marked cell rather than an empty month.
 */
const NOW = '2026-09-02T09:00:00.000Z';

/**
 * The list's inputs, from the SHIPPED calendar rather than a transcription of
 * it — the same file the grid reads, mapped into the shape `buildOverviewEvents`
 * takes.
 */
const MACRO: OvMarketEvent[] = MARKET_EVENTS.map((event) => ({
  id: event.id,
  code: event.kind,
  titleTh: event.titleTh,
  importance: event.importance,
  startsAtUtc: event.at,
}));

const CALENDAR: OvEventCalendar = {
  events: MACRO,
  fromDayKey: '2026-09-02',
  coversThrough: false,
  lastDayKey: '2026-12-31',
};

/**
 * The rows only the list carries. Included on purpose: an option expiry, an
 * earnings date and a price alert are what `upcoming` folded into `events`, and
 * they are what moving to the grid gives up on the Overview.
 */
const UPCOMING: UpcomingFeed = {
  events: [
    {
      id: 'expiry:IREN-C',
      kind: 'option-expiry',
      symbol: 'IREN',
      days: 2,
      contractSymbol: 'IREN260904C00030000',
      expirationDate: '2026-09-04',
      text: 'IREN · Call หมดอายุในอีก 2 วัน',
    },
    {
      id: 'earnings:NVDA:2026-09-16',
      kind: 'earnings',
      symbol: 'NVDA',
      days: 14,
      reportDate: '2026-09-16',
      text: 'NVDA · ประกาศผลประกอบการในอีก 14 วัน',
    },
    {
      id: 'alert:RKLB',
      kind: 'alert',
      symbol: 'RKLB',
      days: null,
      distancePercent: 3.2,
      text: 'RKLB · ใกล้ราคาที่ตั้งแจ้งเตือนไว้',
    },
  ],
  total: 3,
};

const WATCHLIST = ['ASTS', 'CRCL', 'IREN', 'NVDA', 'NVTS', 'ONDS', 'RKLB'];

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/**
 * What the slot costs and whether it is intact, read off the live box model.
 *
 * `dayLinks` is the half a screenshot cannot settle: a grid whose cells link
 * to the wrong day looks exactly like one whose cells link to the right day.
 */
const PROBE = `() => {
  const slot = document.querySelector('[data-qa-slot]');
  if (!slot) return { missing: true };
  const box = slot.getBoundingClientRect();
  return {
    height: Math.round(box.height),
    width: Math.round(box.width),
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    slotOverflows: slot.scrollWidth > slot.clientWidth + 1,
    rows: slot.querySelectorAll('li').length,
    dayCells: slot.querySelectorAll('[data-testid^="market-events-cell-2"]').length,
    dayLinks: [...slot.querySelectorAll('a[data-testid^="market-events-cell-"]')]
      .map((a) => a.getAttribute('href')),
    /*
      Content wider than its own box. The slot can sit inside a column that
      does not scroll while one row inside it is cut — which is the only way a
      Thai release name or an importance chip goes missing quietly.
    */
    clipped: [...slot.querySelectorAll('li, [data-testid^="market-events-cell-"]')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40)),
    /* Anything drawn past the right edge of the slot, at this width. */
    pastRightEdge: (() => {
      const edge = slot.getBoundingClientRect().right;
      return [...slot.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > edge + 1)
        .map((el) => el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 6);
    })(),
    text: slot.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220),
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const listView = buildOverviewEvents({
  window: CALENDAR,
  upcoming: UPCOMING,
  portfolioSymbols: [],
  watchlistSymbols: WATCHLIST,
  now: NOW,
});
const gridView = buildMarketEventsCardView({ now: NOW });

if (!gridView) throw new Error('the card view could not be built for ' + NOW);

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

/** The slot as the Overview wraps it — same `<main>`, same gutters, same panel. */
function pageFor(inner: string): string {
  return '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
    + `<head><meta charset="utf-8"><style>${css}</style></head>`
    + '<body style="background:var(--bg)">'
    + '<main class="mx-auto w-full max-w-[1440px] page-stack px-[var(--page-gutter)] py-4 sm:py-6">'
    + inner
    + '</main></body></html>';
}

const CAPTURES = [
  {
    label: 'before-list',
    what: 'OVERVIEW_ORDER_V2 with `events` — EventsList, the merged list',
    html: pageFor(
      '<div data-qa-slot><section class="panel-quiet min-w-0">'
      + '<div class="mb-2 text-base font-semibold text-[var(--text)]">วันสำคัญที่ใกล้ถึง</div>'
      + renderToString(React.createElement(EventsList, { view: listView }))
      + '</section></div>',
    ),
  },
  {
    label: 'after-grid',
    what: 'OVERVIEW_ORDER_V2 with `marketEvents` — MarketEventsCard, the month grid',
    html: pageFor(
      '<div data-qa-slot>'
      + renderToString(React.createElement(MarketEventsCard, { view: gridView }))
      + '</div>',
    ),
  },
];

const report: Record<string, unknown>[] = [];

for (const capture of CAPTURES) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 1200 },
    deviceScaleFactor: 2,
  });
  await page.route('**/*', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: capture.html,
      });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://localhost/', { waitUntil: 'networkidle' });

  const measured = await page.evaluate(`(${PROBE})()`) as Record<string, unknown>;
  const file = path.join(OUT, `${WIDTH}-${capture.label}.png`);
  await page.locator('[data-qa-slot]').screenshot({ path: file });
  await page.close();

  report.push({ ...capture, html: undefined, file, measured });
  console.log(`\n${capture.label} — ${capture.what}`);
  console.log(`  ${file}`);
  console.log(`  height ${measured.height}px · width ${measured.width}px`
    + ` · rows ${measured.rows} · day cells ${measured.dayCells}`);
  console.log(`  document overflows: ${measured.documentOverflows}`
    + ` · slot overflows: ${measured.slotOverflows}`
    + ` · clipped: ${(measured.clipped as string[]).length}`
    + ` · past right edge: ${(measured.pastRightEdge as string[]).length}`);
  for (const cut of measured.pastRightEdge as string[]) console.log(`    past edge: ${cut}`);

  /*
    Every day link has to carry a month containing its own day. `/market-events`
    drops `?d=` when the two disagree, silently, so a wrong link is a cell that
    looks tappable and lands on a calendar with nothing selected.
  */
  const links = (measured.dayLinks ?? []) as string[];
  const bad = links.filter((href) => {
    const match = /\?m=(\d{4}-\d{2})&d=(\d{4}-\d{2})-\d{2}#/.exec(href ?? '');
    return !match || match[1] !== match[2];
  });
  if (links.length > 0) {
    console.log(`  day links: ${links.length}, mismatched month: ${bad.length}`);
    console.log(`    e.g. ${links[0]}`);
  }
  if (bad.length > 0) {
    console.error(`  FAIL — ${bad.length} day links pair a day with another month`);
    process.exitCode = 1;
  }
  if (measured.documentOverflows || measured.slotOverflows) {
    console.error('  FAIL — the slot overflows its width at ' + WIDTH + 'px');
    process.exitCode = 1;
  }
}

writeFileSync(
  path.join(OUT, `${WIDTH}-report.json`),
  `${JSON.stringify({ width: WIDTH, now: NOW, captures: report }, null, 2)}\n`,
  'utf8',
);
await browser.close();

const [before, after] = report as Array<{ measured: { height: number } }>;
console.log(`\nthe slot at ${WIDTH}px: ${before.measured.height}px as a list,`
  + ` ${after.measured.height}px as a grid`
  + ` (${after.measured.height - before.measured.height >= 0 ? '+' : ''}`
  + `${after.measured.height - before.measured.height}px)`);
console.log(`report: ${path.join(OUT, `${WIDTH}-report.json`)}`);
