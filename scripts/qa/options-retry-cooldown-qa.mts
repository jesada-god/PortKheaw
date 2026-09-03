/**
 * THE OPTIONS RETRY BUTTON AT 375px, WITH A COOLDOWN RUNNING.
 *
 * ===========================================================================
 * WHAT IT WITNESSES
 * ===========================================================================
 * `OptionsLevelsPanel` holds `now` in state and starts it at zero, then reads
 * the real clock in an effect. The countdown is derived from it:
 *
 *     Math.ceil((retryAt - now) / 1_000)
 *
 * so on the FIRST render — before the effect has run — that is
 * `Math.ceil(retryAt / 1000)`, which is the Unix epoch in seconds. The button
 * reads "ลองใหม่ใน 1788429111s": a ten-digit number where a two-digit one
 * belongs, on a control a reader is looking at precisely because something has
 * already gone wrong.
 *
 * It is a single frame in a browser and permanent in any renderer that does not
 * run effects, which is why it survived: `OptionsLevelsPanel.test.tsx` asserted
 * only that no raw provider diagnostic leaked, and the ten-digit number
 * happened to contain "429" on the day the epoch did.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT ONLY A TEST
 * ===========================================================================
 * The unit test can assert the number. It cannot show what a ten-digit
 * countdown does to a 375px row — whether the button grows, pushes the failure
 * message, or overflows the panel — and that is the part of the defect a reader
 * actually meets.
 *
 * `renderToString` is deliberate here rather than incidental: it is the render
 * BEFORE any effect runs, which is exactly the frame the bug lives in.
 *
 * Run: npm run qa:options-retry -- --label before
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { OptionsLevelsPanel } from '@/src/components/stock/chart/technical/OptionsLevelsPanel';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { optionsUnavailable } from '@/src/lib/analytics/options-sr/calculations';

(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args = process.argv.slice(2);
const LABEL = args.includes('--label') ? args[args.indexOf('--label') + 1]! : 'current';
const WIDTH = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 375;
const OUT_DIR = '.qa/artifacts/options-retry-cooldown';

/** Thirty seconds out, which is what the hook actually sets on a 429. */
const COOLDOWN_MS = 30_000;
const RETRY_AT = Date.now() + COOLDOWN_MS;

async function stylesheet(): Promise<string> {
  const entry = path.resolve('app/globals.css');
  return (await postcss([tailwind()])
    .process(await readFile(entry, 'utf8'), { from: entry })).css;
}

/*
 * The rate-limited failure, built by the real presenter so the wording and the
 * withheld diagnostics are the product's own rather than this script's.
 */
const panel = renderToString(React.createElement(
  EntitlementProvider,
  {
    /* The same props `OptionsLevelsPanel.test.tsx` mounts it with. */
    tier: 'elite',
    authenticated: true,
    trialOffer: 'used',
    children: React.createElement(OptionsLevelsPanel, {
      chain: null,
      result: optionsUnavailable('AAPL', null, 'rate-limited', 'HTTP 429 Too Many Requests; Retry-After: 60', 'alpaca'),
      loading: false,
      expirations: [],
      selectedExpiration: null,
      retryAt: RETRY_AT,
      currency: '$',
      expanded: true,
      onToggleExpanded: () => undefined,
      onExpirationChange: () => undefined,
      onRetry: () => undefined,
    }),
  } as never,
));

const PROBE = `() => {
  const button = document.querySelector('[data-testid="options-retry"]');
  const failure = document.querySelector('[data-testid="options-failure"]');
  if (!button || !failure) return { missing: true };
  const box = button.getBoundingClientRect();
  const label = button.innerText.replace(/\\s+/g, ' ').trim();
  const digits = (label.match(/\\d+/) || [''])[0];
  return {
    label,
    seconds: digits ? Number(digits) : null,
    disabled: button.disabled === true,
    buttonWidth: Math.round(box.width),
    buttonHeight: Math.round(box.height),
    failureText: failure.innerText.replace(/\\s+/g, ' ').trim(),
    failureHeight: Math.round(failure.getBoundingClientRect().height),
    /* The row wraps rather than overflowing; both are worth knowing apart. */
    failureOverflows: failure.scrollWidth > failure.clientWidth + 1,
    documentOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}`;

const OUT = path.resolve(OUT_DIR);
mkdirSync(OUT, { recursive: true });

const [css, browser] = await Promise.all([
  stylesheet(),
  chromium.launch({ executablePath: BROWSER, headless: true }),
]);

const html = '<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark">'
  + `<head><meta charset="utf-8"><style>${css}</style></head>`
  + '<body style="background:var(--bg)">'
  + '<main class="mx-auto w-full max-w-[1440px] px-[var(--page-gutter)] py-4">'
  + '<div class="min-w-0 rounded-xl border border-[#242733] bg-[#151B28]">'
  + panel
  + '</div></main></body></html>';

const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
await page.route('**/*', async (route) => {
  const { pathname } = new URL(route.request().url());
  if (pathname === '/') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  await route.fulfill({ status: 404, body: '' });
});
await page.goto('http://options-retry.qa/', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="options-retry"]', { timeout: 10_000 });

const measured = await page.evaluate(`(${PROBE})()`) as Record<string, unknown>;
if (measured.missing) {
  await browser.close();
  throw new Error('the retry button did not render');
}
await page.locator('[data-testid="options-levels"]')
  .screenshot({ path: path.join(OUT, `retry-${WIDTH}-${LABEL}.png`) });
await browser.close();

const seconds = measured.seconds as number | null;
/* Thirty seconds from now, so anything past a minute is not a countdown. */
const plausible = seconds === null || (seconds >= 0 && seconds <= 60);

writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify({
  label: LABEL, viewport: WIDTH, cooldownMs: COOLDOWN_MS, plausible, ...measured,
}, null, 2), 'utf8');

console.log(`OPTIONS RETRY · ${WIDTH}px · ${LABEL}`);
console.log(`  label              : ${measured.label}`);
console.log(`  seconds shown      : ${seconds ?? '(none)'}   expected ~${COOLDOWN_MS / 1000}`);
console.log(`  plausible countdown: ${plausible}`);
console.log(`  button             : ${measured.buttonWidth}×${measured.buttonHeight}px, disabled=${measured.disabled}`);
console.log(`  failure row        : ${measured.failureHeight}px, overflows=${measured.failureOverflows}`);
console.log(`  document overflows : ${measured.documentOverflows}`);
console.log(`  artifacts in ${OUT}`);
