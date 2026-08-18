/**
 * The zone bar, measured in a real browser at the width most readers are on.
 *
 * `MarketSignalSection.test.tsx` can only assert the ABSENCE of classes that cut
 * a line — jsdom has no layout engine, so it cannot tell you that a label three
 * pixels wider than its field is now sitting on top of the next one. This does
 * the other half: it renders the real component to HTML, compiles the app's real
 * stylesheet over it, and asks Chrome for the boxes.
 *
 * It is deliberately NOT the full-page QA (`npm run qa:ui-redesign-auth`), which
 * needs a server and a signed-in Elite account. This mounts one component in one
 * page-width container, so it runs offline, in seconds, on any machine with
 * Chrome, and it fails on the specific thing the redesign could break: a piece
 * of the bar leaving the bar.
 *
 * What it checks, per case, per width:
 *   1. nothing in the card extends past the card's own content box
 *   2. all three zone fields have real width, and each name fits inside its own
 *      field with no overlap into the next
 *   3. every floating label (the "ตอนนี้" marker, the two edge prices) sits
 *      fully inside the track it is positioned against
 *   4. no element is clipping its own text (`scrollWidth > clientWidth`)
 *   5. the document never scrolls sideways
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import type { MarketSignalResult, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';

/*
 * The project compiles JSX with the classic runtime, so the components reach
 * `React.createElement` through a global rather than through an import of their
 * own. `MarketSignalSection.test.tsx` stubs the same global for the same reason.
 */
(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/market-signal-zone-bar';

/** 390x844 is the brief; the two narrower ones are the margin of safety. */
const WIDTHS = [390, 360, 320];
/*
 * Both appearances, because the bar's three fields are the first thing on this
 * card to depend on translucent whites and on the 100-shade status text, and
 * those are exactly the classes the compat layer has to re-point for the light
 * surface. `compat-tokens.test.ts` asserts each class HAS a mapping; this is
 * where a reader can see what the mapping looks like.
 */
const APPEARANCES = ['dark', 'light'] as const;
/** The analytics column's own horizontal padding, so the card gets its real width. */
const PAGE_PADDING = 16;

const base: MarketSignalResult = {
  status: 'available',
  symbol: 'IREN',
  state: 'BULLISH',
  bias: 'bullish',
  score: 34,
  confidence: 62,
  confidenceLabel: 'Medium',
  evidenceAgreement: 62,
  evidenceAgreementLabel: 'Medium',
  timeframe: '1D',
  calculatedAt: '2026-08-18T00:00:00.000Z',
  latestCandleAt: '2026-08-14',
  source: 'yahoo-finance-chart',
  freshness: { status: 'end-of-day', asOf: '2026-08-14T20:00:00.000Z', maxAgeSeconds: 21_600 },
  dataPoints: { received: 260, finalized: 259 },
  scoreBreakdown: {
    emaTrend: { points: 12, maxPoints: 30, normalizedScore: 0.4, coverage: 1, factorsUsed: 4, available: true },
    momentum: { points: 8, maxPoints: 25, normalizedScore: 0.32, coverage: 1, factorsUsed: 3, available: true },
    trendStrength: { points: 4, maxPoints: 15, normalizedScore: 0.27, coverage: 1, factorsUsed: 1, available: true },
    volume: { points: 3, maxPoints: 15, normalizedScore: 0.2, coverage: 1, factorsUsed: 2, available: true },
    priceStructure: { points: 7, maxPoints: 15, normalizedScore: 0.47, coverage: 1, factorsUsed: 2, available: true },
  },
  reasons: [{ id: 'ema-structure', polarity: 'positive', text: 'ราคาและ EMA เรียงตัวเอนขึ้น', impact: 8 }],
  warnings: [],
  flags: ['conflicting_evidence', 'low_volume_confirmation', 'weak_confirmation', 'squeeze', 'strong_momentum'],
  metrics: {
    close: 44.06, ema20: 42, ema50: 40, ema200: 33,
    ema20SlopePct: 1.2, ema50SlopePct: 0.8, ema200SlopePct: 0.3, emaCompressionRatio: 0.04,
    rsi14: 62, macd: 2.1, macdSignal: 1.8, macdHistogram: 0.3,
    adx14: 24, plusDi14: 31, minusDi14: 18, relativeVolume20: 1.4, obvTrend: 'rising',
    bollingerUpper: 48, bollingerMiddle: 44, bollingerLower: 40,
    keltnerUpper: 49, keltnerMiddle: 44, keltnerLower: 39,
    squeezeOn: false, atr14: 4.06, ema20DeviationPct: 3.42, atrNormalizedDistance: 1.71,
    nearestSupport: 39.27, nearestResistance: 46.23, divergence: null,
  },
  confidenceBreakdown: {
    completeness: 85, agreement: 62, evidenceStrength: 34,
    volumeConfirmation: 20, regimeClarity: 100, conflictPenalty: 5,
  },
};

const zones: MarketSignalZones = {
  mode: 'structural',
  zone: 'sideways',
  support: 39.2727,
  resistance: 46.2297,
  upperTrigger: 47.244,
  lowerTrigger: 38.2583,
  positionPct: 68.8,
  upperDistance: 3.184,
  upperDistanceAtr: 0.78,
  lowerDistance: 5.8017,
  lowerDistanceAtr: 1.43,
  frameAgeBars: 12,
  proximity: 'near_trigger',
  nearestTriggerAtr: 0.78,
  zoneAgeBars: 9,
  lastTestedBarsAgo: 0,
  triggerCrossings: 14,
  pendingBreakout: false,
  pendingBreakdown: false,
  entry: null,
  referenceClose: 44.06,
  referenceDate: '2026-08-14',
};

/**
 * The cases, chosen so every branch that positions something lands in at least
 * one of them: marker in the middle, marker jammed against each end, a live
 * price beside the close, a five-digit instrument, and the fully loaded card.
 */
const CASES: Array<{ name: string; result: MarketSignalResult; livePrice: number | null }> = [
  {
    name: 'sideways-mid-frame',
    result: { ...base, state: 'SIDEWAYS', bias: 'neutral', score: 16, zones },
    livePrice: null,
  },
  {
    name: 'live-price-crossed-up',
    result: { ...base, zones: { ...zones, zone: 'uptrend' } },
    livePrice: 47.9,
  },
  {
    name: 'close-pinned-to-the-low-end',
    result: {
      ...base,
      state: 'BEARISH',
      bias: 'bearish',
      score: -42,
      zones: { ...zones, zone: 'downtrend', referenceClose: 30.11, lowerDistance: -8.15, upperDistance: 17.13, zoneAgeBars: 1 },
    },
    livePrice: 29.4,
  },
  {
    name: 'close-pinned-to-the-high-end',
    result: {
      ...base,
      zones: { ...zones, zone: 'uptrend', referenceClose: 61.42, upperDistance: -14.18, lowerDistance: 23.16, frameAgeBars: 2 },
    },
    livePrice: 62.05,
  },
  {
    name: 'five-figure-instrument-with-actionable',
    result: {
      ...base,
      symbol: 'BTC-USD',
      zones: {
        ...zones,
        zone: 'uptrend',
        support: 104_233.41, resistance: 118_902.77,
        lowerTrigger: 103_192.08, upperTrigger: 120_091.68,
        referenceClose: 121_884.35,
        upperDistance: -1792.67, lowerDistance: 18_692.27,
        entry: { level: 118_902.77, height: 14_669.36, mode: 'structural', barsAgo: 1 },
      },
      actionable: {
        invalidation: 118_902.77, invalidationAtr: 0.45, invalidationPct: 2.45, invalidationBasis: 'zone_floor',
        target: 133_572.13, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 3.94, notes: ['risk_leg_inside_noise'],
      },
    },
    livePrice: 122_401.9,
  },
  {
    name: 'actionable-with-every-row',
    result: {
      ...base,
      zones: { ...zones, zone: 'uptrend', entry: { level: 43.72, height: 14.79, mode: 'structural', barsAgo: 1 } },
      actionable: {
        invalidation: 42.24, invalidationAtr: 0.45, invalidationPct: 4.13, invalidationBasis: 'zone_floor',
        target: 58.51, targetAtr: 3.56, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 7.94, notes: [],
      },
    },
    livePrice: 44.58,
  },
];

async function stylesheet(): Promise<string> {
  const from = path.resolve('app/globals.css');
  const source = await readFile(from, 'utf8');
  const compiled = await postcss([tailwind()]).process(source, { from });
  return compiled.css;
}

function markup(entry: (typeof CASES)[number]): string {
  return renderToStaticMarkup(
    React.createElement(
      EntitlementProvider,
      { tier: 'elite', authenticated: true, trialOffer: 'used' },
      React.createElement(MarketSignalSection, { result: entry.result, livePrice: entry.livePrice }),
    ),
  );
}

function page(css: string, width: number, appearance: (typeof APPEARANCES)[number]): string {
  const cards = CASES.map((entry) => `
    <section data-case="${entry.name}" style="width:${width}px;padding:0 ${PAGE_PADDING}px;margin:0 auto 24px;">
      <p style="font:12px monospace;color:#64748b;margin:0 0 6px;">${entry.name} @ ${width}px</p>
      ${markup(entry)}
    </section>`).join('');
  const ground = appearance === 'light' ? '#F6F7F9' : '#0B0F17';
  return `<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="${appearance}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:${ground};} body{overflow-x:hidden;}</style>
</head><body>${cards}</body></html>`;
}

/**
 * The probe, run inside the page.
 *
 * Boxes are compared against the box they are supposed to live in rather than
 * against the viewport, because the interesting failure is local: a label that
 * has left its own field is broken long before anything reaches the edge of the
 * screen. A 0.5px tolerance absorbs subpixel rounding on percentage widths.
 */
interface ZoneBarProblem { case: string; kind: string; detail: string }
interface ZoneBarReport { problems: ZoneBarProblem[]; documentScrollWidth: number }

const PROBE = `() => {
  const TOLERANCE = 0.5;
  const problems = [];
  const note = (caseName, kind, detail) => problems.push({ case: caseName, kind, detail });

  for (const section of document.querySelectorAll('[data-case]')) {
    const name = section.getAttribute('data-case');
    const card = section.querySelector('section[aria-label="Technical Outlook"]');
    if (!card) { note(name, 'missing-card', 'the card did not render'); continue; }
    const cardBox = card.getBoundingClientRect();

    for (const node of card.querySelectorAll('*')) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right > cardBox.right + TOLERANCE || box.left < cardBox.left - TOLERANCE) {
        note(name, 'outside-card', node.className + ' :: ' + (node.textContent || '').slice(0, 40));
      }
      /*
       * Only a box that actually clips can cut a line. Everything here is
       * overflow:visible, where a wide child overflows in plain sight, and
       * scrollWidth counts absolutely-positioned children and pseudo-elements
       * besides — the first version of this probe reported every InfoHint on
       * the card for its own 13px hit-area pseudo-element.
       */
      const overflow = getComputedStyle(node);
      const clips = overflow.overflowX !== 'visible' || overflow.overflowY !== 'visible';
      if (clips && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
        note(name, 'clipped-text', node.className + ' :: ' + (node.textContent || '').slice(0, 40));
      }
    }

    const bar = card.querySelector('[data-testid="signal-zone-bar"]');
    if (!bar) continue;

    const fields = [...bar.querySelectorAll('[data-zone]')];
    if (fields.length !== 3) note(name, 'field-count', 'expected 3 zone fields, found ' + fields.length);
    for (const field of fields) {
      const box = field.getBoundingClientRect();
      if (box.width < 24) note(name, 'field-too-narrow', field.dataset.zone + ' is ' + box.width.toFixed(1) + 'px');
      const label = field.querySelector('span');
      if (!label) { note(name, 'field-unnamed', field.dataset.zone + ' has no name drawn on it'); continue; }
      const labelBox = label.getBoundingClientRect();
      if (labelBox.left < box.left - TOLERANCE || labelBox.right > box.right + TOLERANCE) {
        note(name, 'name-overflows-field', field.dataset.zone + ' name is ' + labelBox.width.toFixed(1) + 'px in a ' + box.width.toFixed(1) + 'px field');
      }
    }

    // The three floating labels: the marker caption above the bar and the two
    // edge prices below it. Each must sit inside the track it is measured on,
    // and the two that share a row must not land on top of each other.
    const edgePrices = [];
    for (const track of bar.querySelectorAll('.relative')) {
      const trackBox = track.getBoundingClientRect();
      for (const floater of track.children) {
        if (getComputedStyle(floater).position !== 'absolute') continue;
        if (!(floater.textContent || '').trim()) continue;
        const box = floater.getBoundingClientRect();
        if (box.left < trackBox.left - TOLERANCE || box.right > trackBox.right + TOLERANCE) {
          note(name, 'label-overhangs-track', (floater.textContent || '').trim() + ' at ' + box.left.toFixed(1) + '-' + box.right.toFixed(1) + ' in ' + trackBox.left.toFixed(1) + '-' + trackBox.right.toFixed(1));
        }
        if (floater.classList.contains('font-mono')) edgePrices.push({ text: (floater.textContent || '').trim(), box });
      }
    }

    if (edgePrices.length === 2) {
      const [left, right] = edgePrices.sort((a, b) => a.box.left - b.box.left);
      if (left.box.right > right.box.left - 2) {
        note(name, 'edge-prices-collide', left.text + ' ends at ' + left.box.right.toFixed(1) + ', ' + right.text + ' starts at ' + right.box.left.toFixed(1));
      }
    }
  }

  return { problems, documentScrollWidth: document.documentElement.scrollWidth };
}`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = await stylesheet();
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const failures: string[] = [];

  try {
    for (const appearance of APPEARANCES) {
    for (const width of WIDTHS) {
      const tag = `${appearance}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
      const tab = await context.newPage();
      const html = page(css, width, appearance);
      writeFileSync(path.join(OUT_DIR, `zone-bar-${tag}.html`), html, 'utf8');
      await tab.setContent(html, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);

      // A string handed to `evaluate` is an EXPRESSION, so the probe has to be
      // called rather than merely named — otherwise the page hands back a
      // function, which is not serializable, and the result arrives undefined.
      const report = await tab.evaluate<ZoneBarReport>(`(${PROBE})()`);
      await tab.screenshot({ path: path.join(OUT_DIR, `zone-bar-${tag}.png`), fullPage: true });
      // One clip per case as well, because the full-page shot at phone width is
      // unreadable when you are trying to look at a 36px-tall bar.
      for (const entry of CASES) {
        const bar = tab.locator(`[data-case="${entry.name}"] [data-testid="signal-zone-bar"]`);
        if (await bar.count()) {
          await bar.screenshot({ path: path.join(OUT_DIR, `bar-${tag}-${entry.name}.png`) });
        }
      }

      if (report.documentScrollWidth > width) {
        failures.push(`${tag} · document scrolls sideways (${report.documentScrollWidth}px)`);
      }
      for (const problem of report.problems) {
        failures.push(`${tag} · ${problem.case} · ${problem.kind} · ${problem.detail}`);
      }
      console.log(`${appearance} ${width}x844 · ${report.problems.length === 0 ? 'clean' : `${report.problems.length} problem(s)`} · scrollWidth ${report.documentScrollWidth}`);
      await context.close();
    }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ widths: WIDTHS, appearances: APPEARANCES, cases: CASES.map((entry) => entry.name), failures }, null, 2), 'utf8');

  if (failures.length) {
    console.error(`\nFAILED · ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASSED · ${CASES.length} case(s) × ${WIDTHS.length} width(s) × ${APPEARANCES.length} appearance(s) · artifacts in ${OUT_DIR}`);
}

await main();
