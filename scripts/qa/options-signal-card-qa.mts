/**
 * The Options Signal card, checked in a real browser after it has hydrated.
 *
 * It replaces `options-signal-header-qa.mts`, whose eight checks all measured
 * the baselines, the divider and the ⓘ of the two-number header — a header that
 * no longer exists, because Phase 1 moved the direction score and the
 * confidence score into the dialog and left the card stating which of the seven
 * readings this is. The old script had no subject left; this one has the three
 * facts that replaced it.
 *
 * WHAT IT CHECKS, per case:
 *   1. NO SCORE ON THE CARD. Neither the direction score nor the confidence
 *      score appears in the card's own text, nor the words that introduced
 *      them, nor a "/ 100".
 *   2. THE NUMBERS ARE STILL REACHABLE. Opening the dialog shows the direction
 *      score, the factor-by-factor breakdown, and the evidence agreement.
 *   3. THE CARD AGREES WITH THE MAPPER. The status the card renders is the one
 *      `OPTIONS_SIGNAL_STATUS` returns for that signal type, and the phrase
 *      beside it is that type's own Thai gloss.
 *
 * TWO RULES CARRIED FROM THE SCRIPT IT REPLACES, both learned the hard way:
 *
 *  - MEASURE THE HYDRATED DOM. This card fetches its own payload, so server
 *    markup is its loading state. The client half stubs `fetch`, hydrates, and
 *    raises `data-hydrated` only once React has committed the card the fetched
 *    payload produced — counted per host, never timed off a frame count.
 *  - SCOPE EVERYTHING TO THE CARD. Every query below runs against the card
 *    element, not the document. The old probe read a row that contained the
 *    card and attributed what it found to the card; a digit in a neighbouring
 *    block would have been reported as a score leaking, and a score genuinely
 *    on the card would have been missed if it sat outside that row.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { OptionsSignalSection } from '@/src/components/analytics/options-signal/OptionsSignalSection';
import { OPTIONS_SIGNAL_STATUS, STATUS_PRESENTATION } from '@/src/lib/presentation/status';
import { OPTIONS_SIGNAL_PRESENTATION } from '@/src/components/analytics/options-signal/presentation';
import { CASES } from './options-signal-header-cases';

/*
 * The project compiles JSX with the classic runtime under tsx, so the
 * components reach `React.createElement` through a global rather than through
 * an import of their own. The zone-bar probe and `MarketSignalSection.test.tsx`
 * stub the same global for the same reason.
 */
(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/options-signal-card';

async function clientBundle(): Promise<string> {
  const built = await build({
    entryPoints: [path.resolve('scripts/qa/options-signal-card-client.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    jsx: 'automatic', target: 'es2022',
    define: { 'process.env.NODE_ENV': '"development"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: { NODE_ENV: "development" } };' },
    alias: { '@': process.cwd(), 'server-only': path.resolve('src/test/server-only-stub.ts') },
    logLevel: 'silent',
  });
  return built.outputFiles[0]!.text;
}

/*
 * `renderToString`, not `renderToStaticMarkup`: this markup is hydrated, and
 * static markup drops the text-node boundaries hydration matches against.
 */
function markup(entry: (typeof CASES)[number]): string {
  return renderToString(React.createElement(
    EntitlementProvider,
    { tier: entry.breakdownEntitled ? 'elite' : 'pro', authenticated: true, trialOffer: 'used' as const },
    React.createElement(OptionsSignalSection, { symbol: entry.name, active: true }),
  ));
}

/** Read the card, scoped to the card. Returns everything the three checks need. */
const PROBE = `(name) => {
  const host = document.querySelector('[data-hydrate="' + name + '"]');
  const card = host && host.querySelector('[data-signal]');
  if (!card) return { missing: true };
  return {
    cardText: card.textContent || '',
    status: card.getAttribute('data-status'),
    headline: (card.querySelector('[data-testid="options-signal-state-headline"]') || {}).textContent || '',
  };
}`;

const DIALOG_PROBE = `() => {
  const dialog = document.querySelector('[role="dialog"]');
  return {
    text: dialog ? dialog.textContent || '' : '',
    score: (document.querySelector('[data-testid="options-signal-score-modal"]') || {}).textContent || '',
  };
}`;

mkdirSync(OUT_DIR, { recursive: true });
const [script, browser] = await Promise.all([clientBundle(), chromium.launch({ executablePath: BROWSER, headless: true })]);
const page = await browser.newPage({ viewport: { width: 430, height: 1400 } });
const failures: string[] = [];
const report: unknown[] = [];

for (const entry of CASES) {
  const html = `<!doctype html><html data-theme="portkheaw" data-appearance="dark"><body>`
    + `<div data-hydrate="${entry.name}">${markup(entry)}</div>`
    + `<script>${script}</script></body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction('document.documentElement.dataset.hydrated === "true"', null, { timeout: 20_000 });

  const card = await page.evaluate<{ missing?: boolean; cardText: string; status: string; headline: string }>(
    `(${PROBE})(${JSON.stringify(entry.name)})`,
  );
  if (card.missing) { failures.push(`${entry.name}: no card rendered`); continue; }

  const { summary } = entry.signal;
  const expected = OPTIONS_SIGNAL_STATUS[summary.signalType as keyof typeof OPTIONS_SIGNAL_STATUS];
  const presentation = OPTIONS_SIGNAL_PRESENTATION[summary.signalType as keyof typeof OPTIONS_SIGNAL_PRESENTATION];

  /*
   * 1 — THE TWO HEADLINE FIGURES, AND THE WORDS THAT INTRODUCED THEM.
   *
   * Checked by SHAPE, not by digit. The first version scanned for the fixture's
   * score and confidence as bare number tokens and failed on two cases: "60"
   * matched inside "30–60 DTE" and "8" inside "อีก 8 วัน". Both are numbers the
   * card is supposed to carry, and a probe that cannot tell a horizon from a
   * score would have to be silenced case by case until it asserted nothing.
   *
   * What identifies a leaked score is its FORM — the "/ 100" denominator, or
   * one of the two labels that stood over it — plus the rule that the headline
   * line itself is words only. That holds whatever the fixture's numbers are.
   */
  for (const banned of ['คะแนนทิศทาง', 'Confidence', '/ 100', '/100']) {
    if (card.cardText.includes(banned)) failures.push(`${entry.name}: card says "${banned}"`);
  }
  if (/\d/.test(card.headline)) {
    failures.push(`${entry.name}: headline carries a figure — "${card.headline}"`);
  }

  // 3 — the card agrees with the mapper, in level and in wording.
  if (card.status !== expected) failures.push(`${entry.name}: card status ${card.status}, mapper says ${expected}`);
  if (!card.headline.includes(presentation.thai)) {
    failures.push(`${entry.name}: headline "${card.headline}" is not "${presentation.thai}"`);
  }
  if (!card.headline.includes(STATUS_PRESENTATION[expected].emoji)) {
    failures.push(`${entry.name}: headline carries no ${expected} mark`);
  }

  // 2 — the numbers are one tap away. Only Elite has a breakdown to open.
  let dialog = { text: '', score: '' };
  if (entry.breakdownEntitled) {
    const trigger = page.getByRole('button', { name: /ดูรายละเอียดการคำนวณ/ });
    await trigger.first().click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    dialog = await page.evaluate<{ text: string; score: string }>(`(${DIALOG_PROBE})()`);
    if (!dialog.score.includes(String(summary.directionScore0to100))) {
      failures.push(`${entry.name}: dialog does not carry the direction score`);
    }
    for (const required of ['ความสอดคล้อง', 'Confidence', 'Macro', 'Trend']) {
      if (!dialog.text.includes(required)) failures.push(`${entry.name}: dialog is missing "${required}"`);
    }
  }

  await page.screenshot({ path: path.join(OUT_DIR, `card-${entry.name}.png`), fullPage: true });
  report.push({ case: entry.name, status: card.status, expected, headline: card.headline, dialogScore: dialog.score });
}

await browser.close();
writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ report, failures }, null, 2), 'utf8');

for (const failure of failures) console.error(`  FAIL · ${failure}`);
if (failures.length) {
  console.error(`\nFAILED · ${failures.length} problem(s) · artifacts in ${OUT_DIR}`);
  process.exit(1);
}
console.log(`PASSED · ${CASES.length} case(s) · artifacts in ${OUT_DIR}`);
