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
 *   3. NO TWO LABELS OVERLAP. Every label the picture draws — the price
 *      captions, the frame's edge prices, the three field names — is measured as
 *      a box and compared against every other one. This is the check the last
 *      round was missing: it measured the distance between the two MARKERS,
 *      which was 36-64px and passed, while "สด 42.59" and the frame's "43.23"
 *      sat on top of each other one row apart. Marks being far enough apart
 *      says nothing about the captions that name them.
 *   4. every label sits fully inside the track row it is positioned against
 *   5. prices are above the bar and frame levels are below it, always. The two
 *      kinds of number are separated by ROW, so no arrangement can put a live
 *      price back beside an edge price
 *   6. every label is joined to each mark it names by a leader that actually
 *      reaches from one to the other
 *   7. every label is at most as wide as the estimate the layout placed it on.
 *      The bar is laid out on the server without a browser, so the estimate in
 *      `estimateLabelWidth` is load-bearing: if a font makes a caption wider
 *      than estimated, the collision arithmetic upstream was wrong and this is
 *      where that is caught
 *   8. no element is clipping its own text (`scrollWidth > clientWidth`)
 *   9. the document never scrolls sideways
 *  10. both price markers are drawn, and each one is actually VISIBLE against
 *      the field it stands on — composited through every translucent ancestor,
 *      in both appearances. This is the `bg-white` failure that got through an
 *      earlier round: in the light appearance that class is mapped to the
 *      SURFACE colour, so the marker was painted the same colour as the thing
 *      behind it and vanished without any box moving anywhere.
 *  11. where the two prices sit in different fields of the frame, the two
 *      markers are far enough apart to read as two marks rather than one
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
const CASES: Array<{
  name: string;
  result: MarketSignalResult;
  livePrice: number | null;
  /** The live price is in a different field from the close, so the two marks
      have to read as two marks at every width and in both appearances. */
  markersApart?: boolean;
}> = [
  {
    name: 'sideways-mid-frame',
    result: { ...base, state: 'SIDEWAYS', bias: 'neutral', score: 16, zones },
    livePrice: null,
  },
  {
    name: 'live-price-crossed-up',
    result: { ...base, zones: { ...zones, zone: 'uptrend' } },
    livePrice: 47.9,
    markersApart: true,
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
  /*
   * IREN, 2026-08-18 — the case the bar was rebuilt for.
   *
   * Upper trigger 43.25, close 44.06, live 42.38: the headline reads BULLISH
   * off a close above the frame while the price on screen has already fallen
   * back inside it. One marker in a green field is a reader concluding the move
   * is still on, so both marks have to be drawn, both have to be visible in
   * both appearances, and they have to be far enough apart to read as two.
   */
  {
    name: 'live-price-back-inside-the-frame',
    result: {
      ...base,
      zones: {
        ...zones,
        zone: 'uptrend',
        upperTrigger: 43.25,
        lowerTrigger: 38.2583,
        referenceClose: 44.06,
        upperDistance: -0.81,
        upperDistanceAtr: -0.2,
        lowerDistance: 5.8017,
        nearestTriggerAtr: -0.2,
        positionPct: 116.2,
      },
      actionable: {
        invalidation: 43.25, invalidationAtr: 0.2, invalidationPct: 1.84, invalidationBasis: 'zone_floor',
        target: 48.24, targetAtr: 1.23, targetBasis: 'measured_move', targetIsConvention: true,
        riskReward: 5.16, notes: ['risk_leg_inside_noise'],
      },
    },
    livePrice: 42.38,
    markersApart: true,
  },
  /*
   * The case that has to be IMPOSSIBLE to pass by accident.
   *
   * Close 44.06, live 43.70, upper trigger 43.90: the live price is 0.82% from
   * the close and 0.46% from the trigger, which is the arrangement that put
   * three numbers into one row on the bar it replaced. Nothing here is far
   * enough from anything else for the layout to get away with placing each
   * caption on its own mark, so this is the case where the merge has to fire —
   * and where, if it stops firing, the overlap check has to be the thing that
   * says so. Reverting the merge and re-running is the falsification: it reports
   * `labels-overlap` on this case at all three widths, in both appearances.
   */
  {
    name: 'live-price-jammed-against-the-trigger',
    result: {
      ...base,
      zones: {
        ...zones,
        zone: 'uptrend',
        upperTrigger: 43.9,
        lowerTrigger: 38.2583,
        referenceClose: 44.06,
        upperDistance: -0.16,
        upperDistanceAtr: -0.04,
        lowerDistance: 5.8017,
        nearestTriggerAtr: -0.04,
        positionPct: 103.2,
      },
    },
    livePrice: 43.7,
    markersApart: true,
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
    <section data-case="${entry.name}" data-markers-apart="${entry.markersApart ? 'true' : 'false'}" data-live="${entry.livePrice === null ? 'false' : 'true'}" style="width:${width}px;padding:0 ${PAGE_PADDING}px;margin:0 auto 24px;">
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
interface MarkerReading { case: string; marker: string; contrast: number; gap: number | null }
/** What a label actually measured, against the estimate it was placed on. */
interface WidthReading { case: string; label: string; measured: number; estimate: number }
interface ZoneBarReport {
  problems: ZoneBarProblem[];
  markers: MarkerReading[];
  widths: WidthReading[];
  documentScrollWidth: number;
}

/**
 * The contrast a price marker has to clear against whatever is behind it.
 *
 * Both marks are translucent ink over a translucent field over the card, so
 * "is it visible" cannot be read off one computed style — the whole stack has
 * to be composited. 1.8 is well under what either marker measures when its
 * class is mapped (the faint live mark reads around 3 in both appearances) and
 * well over the 1.0 an unmapped `bg-white` produces on the light surface,
 * where the marker is painted in the colour of the thing behind it.
 */
const MARKER_MIN_CONTRAST = 1.8;
/** Two marks closer than this on a phone read as one thick mark. */
const MARKER_MIN_GAP = 2;

const PROBE = `() => {
  const TOLERANCE = 0.5;
  const MARKER_MIN_CONTRAST = ${MARKER_MIN_CONTRAST};
  const MARKER_MIN_GAP = ${MARKER_MIN_GAP};
  const problems = [];
  const markers = [];
  const widths = [];
  const note = (caseName, kind, detail) => problems.push({ case: caseName, kind, detail });

  /*
   * Colour, composited the way the screen composites it.
   *
   * A marker's own background is translucent, and so is the zone field under
   * it, and so is the card under that. Reading one computed value tells you
   * nothing about whether a human can see the mark — the light-mode regression
   * this exists to catch had a perfectly valid colour on the marker that
   * happened to be identical to the surface it was painted on.
   */
  const parseColor = (value) => {
    const text = value || '';
    /*
     * Two formats, because the compat layer produces the second one. Chrome
     * computes \`color-mix(in srgb, ...)\` — which is how every translucent
     * mapping in globals.css is written — to \`color(srgb r g b / a)\` with
     * channels in 0..1, not to \`rgba()\`. A parser that only knows rgba reads
     * every mapped element as having no colour at all, which is a probe that
     * fails on exactly the elements it was written to check.
     */
    const srgb = /color\\(\\s*srgb\\s+([^)]+)\\)/.exec(text);
    if (srgb) {
      const parts = srgb[1].split(/[\\s\\/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    const match = /rgba?\\(([^)]+)\\)/.exec(text);
    if (!match) return null;
    const parts = match[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const groundOf = (node) => {
    const stack = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      const color = parseColor(getComputedStyle(el).backgroundColor);
      if (!color || color.a === 0) continue;
      stack.push(color);
      if (color.a === 1) break;
    }
    let ground = stack.length && stack[stack.length - 1].a === 1 ? stack.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (stack.length) ground = over(stack.pop(), ground);
    return ground;
  };
  const luminance = (color) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const contrast = (a, b) => {
    const high = Math.max(luminance(a), luminance(b));
    const low = Math.min(luminance(a), luminance(b));
    return (high + 0.05) / (low + 0.05);
  };

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

    /*
     * Every label the picture draws, as a box.
     *
     * Labels are found by \`data-label\` rather than by "an absolutely positioned
     * child with text in it", because the leaders and stems are absolutely
     * positioned children too and a rule written around them is a rule that
     * silently stops covering the labels. Anything the reader is meant to READ
     * carries the attribute; anything that is only a line does not.
     */
    const labels = [...bar.querySelectorAll('[data-label]')].map((node) => ({
      node,
      key: node.getAttribute('data-label'),
      text: (node.textContent || '').trim(),
      box: node.getBoundingClientRect(),
      estimate: node.getAttribute('data-label-width') === null ? null : Number(node.getAttribute('data-label-width')),
      track: node.closest('[data-track]'),
    }));
    if (labels.length === 0) note(name, 'no-labels', 'the picture drew no labels at all');

    /*
     * THE CHECK THE LAST ROUND WAS MISSING.
     *
     * Every pair, not just the pairs that share a row: the rows are 16-28px tall
     * and a caption that grew could reach the row above it, and "the two numbers
     * are in different rows" was exactly the assumption that let a live price sit
     * on an edge price. Two boxes that overlap on BOTH axes are on top of each
     * other, whatever the markup says about them.
     */
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i];
        const b = labels[j];
        const overlapX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const overlapY = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (overlapX > TOLERANCE && overlapY > TOLERANCE) {
          note(name, 'labels-overlap',
            a.key + ' "' + a.text + '" and ' + b.key + ' "' + b.text + '" overlap by '
            + overlapX.toFixed(1) + 'x' + overlapY.toFixed(1) + 'px');
        }
      }
    }

    const barRow = bar.querySelector('[data-track="bar"]');
    const barBox = barRow ? barRow.getBoundingClientRect() : null;
    if (!barRow) note(name, 'missing-bar-row', 'the bar itself is not marked as a track');

    const markX = (which) => {
      const node = bar.querySelector('[data-marker="' + which + '"]') || bar.querySelector('[data-cut="' + which + '"]');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return (box.left + box.right) / 2;
    };

    for (const label of labels) {
      // Inside the row it is positioned against. A label that has left its track
      // is broken long before anything reaches the edge of the card.
      if (label.track) {
        const trackBox = label.track.getBoundingClientRect();
        if (label.box.left < trackBox.left - TOLERANCE || label.box.right > trackBox.right + TOLERANCE) {
          note(name, 'label-overhangs-track',
            label.key + ' "' + label.text + '" at ' + label.box.left.toFixed(1) + '-' + label.box.right.toFixed(1)
            + ' in ' + trackBox.left.toFixed(1) + '-' + trackBox.right.toFixed(1));
        }
      } else {
        note(name, 'label-outside-any-track', label.key + ' "' + label.text + '" is not in a track row');
      }

      // No wider than the layout was told to expect. The estimate is what the
      // collision arithmetic ran on, so an underestimate is a wrong answer
      // upstream even when nothing has visibly collided yet.
      if (label.estimate !== null) {
        if (label.box.width > label.estimate + TOLERANCE) {
          note(name, 'label-wider-than-estimated',
            label.key + ' "' + label.text + '" measures ' + label.box.width.toFixed(1)
            + 'px against an estimate of ' + label.estimate + 'px');
        } else if (label.estimate > label.box.width * 1.4 + 8) {
          // The other direction costs readability rather than correctness: a
          // caption estimated far too wide gets merged with its neighbour when
          // the two had room to stand apart.
          note(name, 'label-estimate-too-wide',
            label.key + ' "' + label.text + '" measures ' + label.box.width.toFixed(1)
            + 'px against an estimate of ' + label.estimate + 'px');
        }
        widths.push({
          case: name,
          label: label.key,
          measured: Number(label.box.width.toFixed(1)),
          estimate: label.estimate,
        });
      }

      // Prices above the bar, frame levels below it. This is the separation the
      // rebuild is FOR, so it is asserted rather than assumed.
      if (barBox) {
        const level = label.key === 'edges' || label.key.indexOf('edge-') === 0;
        const price = label.key === 'prices' || label.key === 'close' || label.key === 'live';
        if (price && label.box.bottom > barBox.top + TOLERANCE) {
          note(name, 'price-caption-not-above-the-bar', label.key + ' "' + label.text + '" reaches ' + label.box.bottom.toFixed(1) + ', bar starts at ' + barBox.top.toFixed(1));
        }
        if (level && label.box.top < barBox.bottom - TOLERANCE) {
          note(name, 'frame-level-not-below-the-bar', label.key + ' "' + label.text + '" starts at ' + label.box.top.toFixed(1) + ', bar ends at ' + barBox.bottom.toFixed(1));
        }
      }

      // Joined to every mark it names. A caption that has been pushed off centre
      // is only readable if a reader can see which line it came from.
      if (label.key.indexOf('zone-') === 0) continue;
      const leaders = [...bar.querySelectorAll('[data-leader-for="' + label.key + '"]')];
      if (leaders.length === 0) {
        note(name, 'label-has-no-leader', label.key + ' "' + label.text + '" points at no mark');
        continue;
      }
      for (const leader of leaders) {
        const which = leader.getAttribute('data-leader');
        const x = markX(which);
        if (x === null) { note(name, 'leader-points-at-nothing', label.key + ' leads to ' + which + ', which is not drawn'); continue; }
        const box = leader.getBoundingClientRect();
        const reaches = box.left <= Math.min(x, label.box.right) + 1.5
          && box.right >= Math.max(x, label.box.left) - 1.5;
        if (!reaches) {
          note(name, 'leader-does-not-reach',
            label.key + ' "' + label.text + '" sits at ' + label.box.left.toFixed(1) + '-' + label.box.right.toFixed(1)
            + ' and its ' + which + ' leader spans ' + box.left.toFixed(1) + '-' + box.right.toFixed(1)
            + ' for a mark at ' + x.toFixed(1));
        }
        if (label.track) {
          const trackBox = label.track.getBoundingClientRect();
          if (box.top < trackBox.top - TOLERANCE || box.bottom > trackBox.bottom + TOLERANCE) {
            note(name, 'leader-outside-track', label.key + ' leader for ' + which + ' left its row');
          }
        }
      }
    }

    /*
     * The two price markers. The close is what every number on the card is
     * measured from; the live one is the number the reader can see at the top
     * of the screen. Drawing only one of them is how a card says "still going
     * up" about a price that has already come back.
     */
    const close = bar.querySelector('[data-marker="close"]');
    const live = bar.querySelector('[data-marker="live"]');
    const hasLive = section.getAttribute('data-live') === 'true';
    if (!close) note(name, 'marker-missing', 'the close marker is not drawn');
    if (hasLive && !live) note(name, 'marker-missing', 'the live price was given but no live marker is drawn');

    for (const marker of [close, live]) {
      if (!marker) continue;
      const which = marker.getAttribute('data-marker');
      const box = marker.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) {
        note(name, 'marker-has-no-size', which + ' is ' + box.width.toFixed(1) + 'x' + box.height.toFixed(1));
        continue;
      }
      const own = parseColor(getComputedStyle(marker).backgroundColor);
      if (!own || own.a === 0) { note(name, 'marker-invisible', which + ' has no background colour'); continue; }
      const ground = groundOf(marker);
      const painted = over(own, ground);
      const ratio = contrast(painted, ground);
      markers.push({ case: name, marker: which, contrast: Number(ratio.toFixed(2)), gap: null });
      if (ratio < MARKER_MIN_CONTRAST) {
        note(name, 'marker-invisible', which + ' reads ' + ratio.toFixed(2) + ':1 against what is behind it');
      }
    }

    // Two marks that are genuinely in different fields of the frame must read
    // as two marks, at every width and in both appearances.
    if (close && live && section.getAttribute('data-markers-apart') === 'true') {
      const closeBox = close.getBoundingClientRect();
      const liveBox = live.getBoundingClientRect();
      const gap = Math.max(closeBox.left, liveBox.left) - Math.min(closeBox.right, liveBox.right);
      markers.push({ case: name, marker: 'gap', contrast: 0, gap: Number(gap.toFixed(1)) });
      if (gap < MARKER_MIN_GAP) {
        note(name, 'markers-collide', 'close and live are ' + gap.toFixed(1) + 'px apart');
      }
    }
  }

  return { problems, markers, widths, documentScrollWidth: document.documentElement.scrollWidth };
}`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = await stylesheet();
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const failures: string[] = [];
  const readings: Array<MarkerReading & { at: string }> = [];
  const labelWidths: Array<WidthReading & { at: string }> = [];

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
      // The marker readings are printed, not just asserted: a threshold nobody
      // can see the margin on is a threshold that gets loosened by whoever
      // trips it next.
      const worst = report.markers.filter((entry) => entry.marker !== 'gap')
        .sort((a, b) => a.contrast - b.contrast)[0];
      const gaps = report.markers.filter((entry) => entry.gap !== null);
      /*
       * The width estimate's smallest margin, printed for the same reason: it is
       * the number that decides whether two captions merge, and the day a font
       * change eats the margin the print is where somebody sees it coming.
       */
      const tightest = [...report.widths].sort(
        (a, b) => (a.estimate - a.measured) - (b.estimate - b.measured),
      )[0];
      console.log(
        `${appearance} ${width}x844 · ${report.problems.length === 0 ? 'clean' : `${report.problems.length} problem(s)`}`
        + ` · scrollWidth ${report.documentScrollWidth}`
        + (worst ? ` · faintest marker ${worst.contrast}:1 (${worst.case} ${worst.marker})` : '')
        + (gaps.length ? ` · marker gap ${gaps.map((entry) => `${entry.gap}px`).join(', ')}` : '')
        + (tightest
          ? ` · tightest label estimate +${(tightest.estimate - tightest.measured).toFixed(1)}px`
            + ` (${tightest.case} ${tightest.label})`
          : ''),
      );
      readings.push(...report.markers.map((entry) => ({ ...entry, at: tag })));
      labelWidths.push(...report.widths.map((entry) => ({ ...entry, at: tag })));
      await context.close();
    }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({
    widths: WIDTHS,
    appearances: APPEARANCES,
    cases: CASES.map((entry) => entry.name),
    markerMinContrast: MARKER_MIN_CONTRAST,
    markerMinGap: MARKER_MIN_GAP,
    markers: readings,
    labelWidths,
    failures,
  }, null, 2), 'utf8');

  if (failures.length) {
    console.error(`\nFAILED · ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASSED · ${CASES.length} case(s) × ${WIDTHS.length} width(s) × ${APPEARANCES.length} appearance(s) · artifacts in ${OUT_DIR}`);
}

await main();
