/**
 * EVERY STATUS MARK IN THE PRODUCT, AT 375px, BEFORE AND AFTER.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A TEST
 * ===========================================================================
 * The change this captures is a change of SHAPE. `StatusLabel.test.tsx` can
 * prove that a falling reading emits `trending_down`, and it does; what it
 * cannot answer is whether a 1em arrow sits on the text baseline, whether it
 * grows into competition with the figure above it, and whether swapping a
 * 0.8em emoji for an inline SVG moved a single row by a single pixel at the
 * width most readers hold. jsdom has no box model, so those three are measured
 * here or they are guessed at.
 *
 * ===========================================================================
 * WHY A SPECIMEN SHEET AND NOT TWENTY-THREE PAGE CAPTURES
 * ===========================================================================
 * The mark is drawn in exactly one place — `StatusMark`, reached through
 * `StatusLabel` — so every surface that changed, changed in the same way. What
 * differs between them is only the size and weight of the text the mark is
 * dropped beside: `text-lg` on the market headline, `text-[11px]` on an event's
 * importance, `text-xs` under a price. So every call site is reproduced in
 * `status-direction-marks-client.tsx` at its OWN className and its OWN level,
 * named by the file and line it came from, and the sheet is captured whole.
 * Twenty-three page captures would need twenty-three fixtures and would still
 * be testing this one component.
 *
 * The sheet is server-rendered into the app's own compiled `globals.css`,
 * through the real Tailwind pipeline, so `--positive`, `--caution` and every
 * utility resolve exactly as they do in the product.
 *
 * ===========================================================================
 * WHAT "BEFORE" MEANS HERE, EXACTLY
 * ===========================================================================
 * `--label before` forces every row to `mark="dot"`. That is not an
 * approximation of the old rendering, it IS the old rendering: the dot branch
 * of `StatusMark` emits the same `<span aria-hidden className="shrink-0
 * text-[0.8em] leading-none">` the component emitted before this change, and
 * the four rows marked KEEPS ITS DOT are the ones that still emit it after. So
 * a before/after pair captured this way differs in precisely the thing under
 * review and in nothing else — no rebuild, no stash, and no risk of
 * photographing an unrelated working-tree change as if it were this one.
 *
 * Run:  npm run qa:status-marks -- --label before
 *       npm run qa:status-marks -- --label after
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { StatusMarkKind } from '@/src/components/ui/StatusLabel';
import { Sheet } from './status-direction-marks-client';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1]! : 'after';
const WIDTH = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 375;
const OUT_DIR = '.qa/artifacts/status-marks';

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/**
 * Measure what a screenshot cannot be diffed on.
 *
 * The mark's box and its offset from the word's baseline are the two numbers
 * that decide whether an arrow reads as part of the line or as something
 * sitting beside it, and the row height is the one a change here is not
 * allowed to move.
 */
const PROBE = `() => {
  const sheet = document.querySelector('[data-testid="status-mark-sheet"]');
  if (!sheet) return { missing: true };
  const rows = [...sheet.querySelectorAll('li[data-spec]')].map((li) => {
    const body = li.querySelector('[data-spec-body]');
    const mark = li.querySelector('[aria-hidden="true"][data-status-mark]');
    const word = li.querySelector('[data-status] span:last-child');
    const markBox = mark ? mark.getBoundingClientRect() : null;
    const wordBox = word ? word.getBoundingClientRect() : null;
    return {
      where: li.getAttribute('data-spec'),
      kind: mark ? mark.getAttribute('data-status-mark') : null,
      rowHeight: Math.round(li.getBoundingClientRect().height * 10) / 10,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height * 10) / 10 : null,
      markPx: markBox ? Math.round(markBox.width * 10) / 10 : null,
      fontPx: word ? Math.round(parseFloat(getComputedStyle(word).fontSize) * 10) / 10 : null,
      /* How far the mark's bottom sits from the word's bottom. Zero is level. */
      baselineDriftPx: markBox && wordBox
        ? Math.round((markBox.bottom - wordBox.bottom) * 10) / 10
        : null,
      text: (body ? body.innerText : li.innerText).replace(/\\s+/g, ' ').trim(),
      clipped: li.scrollWidth > li.clientWidth + 1,
    };
  });
  return {
    rows,
    vocabulary: [...sheet.querySelectorAll('[data-vocab]')].map((li) => ({
      level: li.getAttribute('data-vocab'),
      kind: li.querySelector('[data-status-mark]').getAttribute('data-status-mark'),
    })),
    sheetHeight: Math.round(sheet.getBoundingClientRect().height),
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    clippedRows: rows.filter((row) => row.clipped).map((row) => row.where),
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const force: StatusMarkKind | null = LABEL === 'before' ? 'dot' : null;

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

const html = '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
  + `<head><meta charset="utf-8"><style>${css}</style></head>`
  + '<body style="background:var(--bg)">'
  + '<main class="mx-auto w-full max-w-[1440px] page-stack px-[var(--page-gutter)] py-4 sm:py-6">'
  + renderToString(React.createElement(Sheet, { force }))
  + '</main></body></html>';

const page = await browser.newPage({ viewport: { width: WIDTH, height: 1200 }, deviceScaleFactor: 2 });
await page.route('**/*', async (route) => {
  const { pathname } = new URL(route.request().url());
  if (pathname === '/') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  await route.fulfill({ status: 404, body: '' });
});
await page.goto('http://status-marks.qa/', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="status-mark-sheet"]', { timeout: 10_000 });

const measured = await page.evaluate<{
  missing?: boolean;
  rows: {
    where: string; kind: string | null; rowHeight: number; bodyHeight: number | null;
    markPx: number | null; fontPx: number | null; baselineDriftPx: number | null;
    text: string; clipped: boolean;
  }[];
  vocabulary: { level: string; kind: string }[];
  sheetHeight: number;
  documentOverflows: boolean;
  clippedRows: string[];
}>(`(${PROBE})()`);

if (measured.missing) {
  await browser.close();
  throw new Error('the specimen sheet did not render');
}

await page.locator('[data-testid="status-mark-sheet"]')
  .screenshot({ path: path.join(OUT, `status-marks-${WIDTH}-${LABEL}.png`) });
await browser.close();

writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify({
  label: LABEL, viewport: WIDTH, ...measured,
}, null, 2), 'utf8');

console.log(`STATUS MARKS · ${WIDTH}px · ${LABEL}`);
console.log(`  sheet height : ${measured.sheetHeight}px`);
console.log(`  vocabulary   : ${measured.vocabulary.map((v) => `${v.level}=${v.kind}`).join('  ')}`);
console.log('  where                              mark             font  markbox  drift    row');
for (const row of measured.rows) {
  console.log(
    `  ${row.where.padEnd(34)} ${String(row.kind).padEnd(16)} `
    + `${String(row.fontPx).padStart(4)}  ${String(row.markPx).padStart(7)}  `
    + `${String(row.baselineDriftPx).padStart(5)}  ${String(row.rowHeight).padStart(5)}`,
  );
}
console.log(`  document overflows : ${measured.documentOverflows}`);
console.log(`  clipped rows       : ${measured.clippedRows.length ? measured.clippedRows.join(' | ') : 'none'}`);
console.log(`  artifacts in ${OUT}`);
