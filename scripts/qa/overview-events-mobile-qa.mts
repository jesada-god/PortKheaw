/**
 * THE EVENTS SECTION AT 375px, MEASURED AND CAPTURED.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A TEST
 * ===========================================================================
 * The three defects this exists to witness are all about what reaches a
 * reader's eye, and two of them are invisible to jsdom: whether a metadata line
 * wraps, and whether a group heading has anything under it. jsdom has no box
 * model. `events-feed.test.ts` pins the payload and `EventsList` is asserted
 * through the DOM in its own test; this pins the rendered page.
 *
 * ===========================================================================
 * IT RENDERS THE REAL PIPELINE
 * ===========================================================================
 * The fixture is a calendar and an Upcoming feed handed to `buildOverviewEvents`
 * — not a hand-written view — so the date labels, the symbol join and the
 * ordering are the ones the product computes. The four macro releases and the
 * seven symbols are the ones from the production report that opened this.
 *
 * The section is drawn inside the same `<main>` and `panel-quiet` the dashboard
 * wraps it in, against the app's own compiled stylesheet, because a metadata
 * line that fits in one width and wraps in another is the whole question.
 *
 * Run: npm run qa:overview-events -- --label before
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
import { EventsList } from '@/src/components/dashboard/EventsList';
import type { OvEventCalendar, OvMarketEvent } from '@/src/lib/market-overview/events';
import type { UpcomingFeed } from '@/src/lib/upcoming/types';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1]! : 'current';
const WIDTH = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 375;
const OUT_DIR = '.qa/artifacts/overview-events';

const NOW = '2026-09-02T09:00:00.000Z';

/** The four releases the production report showed, with their real codes. */
const MACRO: OvMarketEvent[] = [
  {
    id: 'jobless-2026-09-03',
    code: 'JOBLESS_CLAIMS',
    titleTh: 'ตัวเลขผู้ขอรับสวัสดิการว่างงาน',
    importance: 'medium',
    startsAtUtc: '2026-09-03T12:30:00.000Z',
  },
  {
    id: 'nfp-2026-09-04',
    code: 'NFP',
    titleTh: 'การจ้างงานนอกภาคเกษตร',
    importance: 'high',
    startsAtUtc: '2026-09-04T12:30:00.000Z',
  },
  {
    id: 'ppi-2026-09-10',
    code: 'PPI',
    titleTh: 'ดัชนีราคาผู้ผลิต',
    importance: 'medium',
    startsAtUtc: '2026-09-10T12:30:00.000Z',
  },
  {
    id: 'cpi-2026-09-11',
    code: 'CPI',
    titleTh: 'ดัชนีราคาผู้บริโภค',
    importance: 'high',
    startsAtUtc: '2026-09-11T12:30:00.000Z',
  },
];

const CALENDAR: OvEventCalendar = {
  events: MACRO,
  fromDayKey: '2026-09-02',
  coversThrough: false,
  lastDayKey: '2026-12-31',
};

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

/** The seven from the report, in the order the reader's lists produce them. */
const WATCHLIST = ['ASTS', 'CRCL', 'IREN', 'NVDA', 'NVTS', 'ONDS', 'RKLB'];

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/**
 * Read every row as a reader meets it: the sentence, and the metadata line
 * under it. The metadata line is where both the duplicated date and the symbol
 * list live, so it is captured verbatim rather than summarised.
 */
const PROBE = `() => {
  const section = document.querySelector('[data-testid="overview-events"]');
  if (!section) return { missing: true };
  const rows = [...section.querySelectorAll('li')].map((li) => {
    const meta = li.querySelector('p');
    const box = li.getBoundingClientRect();
    return {
      text: (li.querySelector('div') || li).innerText.replace(/\\s+/g, ' ').trim(),
      meta: meta ? meta.innerText.replace(/\\s+/g, ' ').trim() : null,
      metaHeight: meta ? Math.round(meta.getBoundingClientRect().height) : null,
      links: [...li.querySelectorAll('a')].map((a) => a.textContent.trim()),
      height: Math.round(box.height * 10) / 10,
    };
  });
  return {
    headings: [...section.querySelectorAll('h2, h3, [data-testid$="-heading"]')]
      .map((h) => h.innerText.trim()),
    rows,
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    sectionHeight: Math.round(section.getBoundingClientRect().height),
    /*
      A row whose own content is wider than its box. The section sits in a
      horizontal-scroll-free column, so this is the only way an importance chip
      or a long Thai title can be silently cut: the document does not overflow,
      one row does.
    */
    clippedRows: [...section.querySelectorAll('li')]
      .filter((li) => li.scrollWidth > li.clientWidth + 1)
      .map((li) => li.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40)),
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const view = buildOverviewEvents({
  window: CALENDAR,
  upcoming: UPCOMING,
  portfolioSymbols: [],
  watchlistSymbols: WATCHLIST,
  now: NOW,
});

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

const html = '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
  + `<head><meta charset="utf-8"><style>${css}</style></head>`
  + '<body style="background:var(--bg)">'
  + '<main class="mx-auto w-full max-w-[1440px] page-stack px-[var(--page-gutter)] py-4 sm:py-6">'
  + '<section class="panel-quiet min-w-0">'
  + '<div class="mb-2 text-base font-semibold text-[var(--text)]">วันสำคัญที่ใกล้ถึง</div>'
  + renderToString(React.createElement(EventsList, { view }))
  + '</section></main></body></html>';

const page = await browser.newPage({ viewport: { width: WIDTH, height: 1200 }, deviceScaleFactor: 2 });
await page.route('**/*', async (route) => {
  const { pathname } = new URL(route.request().url());
  if (pathname === '/') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  await route.fulfill({ status: 404, body: '' });
});
await page.goto('http://overview-events.qa/', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="overview-events"]', { timeout: 10_000 });

const measured = await page.evaluate<{
  missing?: boolean;
  headings: string[];
  rows: { text: string; meta: string | null; metaHeight: number | null; links: string[]; height: number }[];
  documentOverflows: boolean;
  sectionHeight: number;
  clippedRows: string[];
}>(`(${PROBE})()`);

if (measured.missing) {
  await browser.close();
  throw new Error('the events section did not render');
}

await page.locator('[data-testid="overview-events"]')
  .screenshot({ path: path.join(OUT, `events-${WIDTH}-${LABEL}.png`) });
await browser.close();

writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify({
  label: LABEL, viewport: WIDTH, ...measured,
}, null, 2), 'utf8');

console.log(`EVENTS · ${WIDTH}px · ${LABEL}`);
console.log(`  section height : ${measured.sectionHeight}px`);
console.log(`  headings       : ${measured.headings.length ? measured.headings.join(' | ') : '(none)'}`);
for (const row of measured.rows) {
  console.log(`  ${row.text}`);
  console.log(`      meta  : ${row.meta ?? '(none)'}${row.metaHeight !== null ? `  [${row.metaHeight}px]` : ''}`);
  console.log(`      links : ${row.links.length ? row.links.join(' ') : '(none)'}`);
}
console.log(`  document overflows : ${measured.documentOverflows}`);
console.log(`  clipped rows       : ${measured.clippedRows.length ? measured.clippedRows.join(' | ') : 'none'}`);
console.log(`  artifacts in ${OUT}`);
