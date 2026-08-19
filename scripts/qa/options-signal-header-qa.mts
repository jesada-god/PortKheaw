/**
 * The Options Signal card header, measured VERTICALLY, in a real browser.
 *
 * The round before this one measured the header horizontally — the gap between
 * the two groups against the gap inside each one — and shipped a pair that was
 * correctly spaced sideways and half a line out of register up and down. The
 * word "Confidence" carries an ⓘ, the ⓘ is an 18px box, the label line is 11px
 * type at `leading-tight` (13.75px), and a flex row is as tall as its tallest
 * item: so the Confidence label sat 2px lower than "คะแนนทิศทาง" and its number
 * sat 4px lower than the score, on a card where the two numbers are meant to be
 * read as a pair. Nothing about that is visible to jsdom, and nothing about it
 * was visible to a probe that only measured x.
 *
 * So this measures y, and it measures BASELINES rather than boxes. Box tops are
 * not the thing a reader aligns on: two runs of type whose boxes start at the
 * same y still look staggered when the line boxes differ, and two whose boxes
 * differ can sit perfectly if the baselines agree. The baseline is the line the
 * eye actually follows across the card.
 *
 * WHAT IT CHECKS, per case, per width:
 *   1. the two label baselines are within 1px of each other;
 *   2. the two value baselines are within 1px of each other;
 *   3. the two groups START at the same y — an outer container that lets one
 *      column drop is a different defect from a label row that grows, and the
 *      two are told apart here rather than summed;
 *   4. the label row is exactly one line tall in BOTH columns, so the ⓘ is not
 *      pushing the row it sits in — the rule the fix is actually written
 *      against, stated on the property rather than on the symptom;
 *   5. the divider between them covers both lines: it starts at or above the
 *      higher label box and ends at or below the lower value box, and it is
 *      actually painted (a border with width);
 *   6. nothing in the header overflows the card's content box, and the document
 *      never scrolls sideways;
 *   7. no console error, which is how a broken render would otherwise pass as
 *      a clean set of numbers;
 *   8. the ⓘ measures 18x18 and its tap target measures at least 44x44. This is
 *      the rule that found the defect: `globals.css` puts a `min-height: 44px`
 *      floor under every button, a floor beats a height, and the icon that
 *      `InfoHint` documents as "18px, tap target added without affecting
 *      layout" was an 18px glyph inside a 44px box everywhere it appeared.
 *
 * HOW A BASELINE IS MEASURED, and why it can be trusted. A zero-sized
 * `inline-block` at `vertical-align: baseline` sits with its top, its bottom and
 * its baseline all on the baseline of the line box it joins, so its
 * `getBoundingClientRect().top` IS that baseline in viewport coordinates. Inside
 * a flex container that trick fails — the probe becomes a flex item and stops
 * participating in the text's line box — so where the text is a bare run inside
 * a flex row it is first wrapped in a `<span>`, which reproduces exactly the
 * anonymous flex item the run already generated.
 *
 * Neither claim is taken on trust. Two controls run on every page before any
 * header is read, and a failure in either aborts the run rather than being
 * reported alongside the readings:
 *
 *   A. two identical spans on one line must measure the SAME baseline (this is
 *      the probe metric itself: if it cannot report zero for two things that
 *      are level, no number it reports about the header means anything);
 *   B. wrapping a text run inside a flex row must move NOTHING — every box on
 *      that row is measured before and after the wrap and has to be identical.
 *
 *   npm run qa:options-signal-header
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { SignalCard } from '@/src/components/analytics/options-signal/OptionsSignalSection';
import { CASES } from './options-signal-header-cases';

/*
 * The project compiles JSX with the classic runtime, so the components reach
 * `React.createElement` through a global rather than through an import of their
 * own — the same reason the jsdom test stubs it.
 */
(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/options-signal-header';

/**
 * 1280 is the desktop width the pairing was designed at, 380 the phone width the
 * brief names, and 320 the narrowest supported — the width where the header row
 * wraps and the two groups can end up on a line of their own.
 */
const WIDTHS = [1280, 380, 320];
/** The analytics column's own horizontal padding, so the card gets its real width. */
const PAGE_PADDING = 16;

/**
 * How far apart two baselines may be before they read as staggered.
 *
 * One pixel, and it is a budget for subpixel rounding rather than for design
 * latitude: the two runs are the same size at the same `leading`, so anything
 * they can honestly differ by is under half a pixel. The defect this replaces
 * measured 2px on the labels and 4px on the values.
 */
const BASELINE_TOLERANCE = 1;
/** Box-edge comparisons, where half a pixel of rounding is normal. */
const EDGE_TOLERANCE = 0.5;

async function stylesheet(): Promise<string> {
  const from = path.resolve('app/globals.css');
  const source = await readFile(from, 'utf8');
  const compiled = await postcss([tailwind()]).process(source, { from });
  return compiled.css;
}

/**
 * Static markup, deliberately, and this is the one place this probe differs
 * from the zone-bar one it is modelled on.
 *
 * The zone bar DECIDES its arrangement from boxes it measures in the browser, so
 * probing its server markup would be probing the fallback. The header decides
 * nothing: it is four boxes in two columns of CSS, identical before and after
 * hydration. Rendering it statically keeps the probe to one process and means a
 * failure here is a failure of the stylesheet rather than of a bundle.
 */
function markup(entry: (typeof CASES)[number]): string {
  return renderToStaticMarkup(
    React.createElement(SignalCard, {
      signal: entry.signal,
      breakdownEntitled: entry.breakdownEntitled,
      open: false,
      onOpenChange: () => {},
    }),
  );
}

function page(css: string, width: number): string {
  const cards = CASES.map((entry) => `
    <section data-case="${entry.name}" style="width:${width}px;padding:0 ${PAGE_PADDING}px;margin:0 auto 24px;">
      <p style="font:12px monospace;color:#64748b;margin:0 0 6px;">${entry.name} @ ${width}px</p>
      ${markup(entry)}
    </section>`).join('');
  return `<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:#0B0F17;} body{overflow-x:hidden;}</style>
<style>
  /* Control A: two identical runs on one line. Their baselines must agree. */
  #qa-control-a { font: 11px/1.25 ui-sans-serif, system-ui, sans-serif; }
  /* Control B: a flex row shaped like the Confidence label — text beside a box
     taller than the line — so the wrap used to probe it is exercised on the
     same geometry the header has. */
  #qa-control-b { display: flex; align-items: center; gap: 4px; font: 11px/1.25 ui-sans-serif, system-ui, sans-serif; }
  #qa-control-b i { display: inline-block; width: 18px; height: 18px; }
</style>
</head><body>
<div id="qa-controls" style="position:absolute;left:-9999px;top:0;">
  <div id="qa-control-a"><span data-qa="a1">Confidence</span><span data-qa="a2">Confidence</span></div>
  <div id="qa-control-b"><span data-qa="b-text">Confidence</span><i data-qa="b-box"></i></div>
</div>
${cards}
<script>window.__qaErrors = [];
addEventListener('error', (event) => window.__qaErrors.push(String(event.message)));
const consoleError = console.error;
console.error = (...args) => { window.__qaErrors.push(args.map(String).join(' ')); consoleError(...args); };
</script>
</body></html>`;
}

interface HeaderProblem { case: string; kind: string; detail: string }
/** One group's four numbers, all relative to the top of the pair container. */
interface GroupReading {
  case: string;
  group: 'score' | 'confidence';
  /** Top of the group's own box, from the top of the pair container. */
  top: number;
  /** Top of the pair container to the LABEL's baseline. */
  labelBaseline: number;
  /** Top of the pair container to the VALUE's baseline. */
  valueBaseline: number;
  /** The label row's own height, against the one line of type it holds. */
  labelHeight: number;
  labelLineHeight: number;
}
interface ControlReading { name: string; delta: number; ok: boolean; detail: string }
interface HeaderReport {
  controls: ControlReading[];
  groups: GroupReading[];
  problems: HeaderProblem[];
  documentScrollWidth: number;
}

const PROBE = `() => {
  const BASELINE_TOLERANCE = ${BASELINE_TOLERANCE};
  const EDGE_TOLERANCE = ${EDGE_TOLERANCE};
  const problems = [];
  const groups = [];
  const controls = [];
  const round = (value) => Math.round(value * 100) / 100;

  /*
   * A zero-sized inline-block on the baseline: its top edge IS the baseline of
   * whatever line box it joins. Everything below is built on this one fact, and
   * control A is what stops it from being an assumption.
   */
  const probeInto = (host) => {
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;font-size:inherit;line-height:inherit;';
    host.appendChild(probe);
    const top = probe.getBoundingClientRect().top;
    probe.remove();
    return top;
  };

  const isFlexLike = (element) => {
    const display = getComputedStyle(element).display;
    return display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid';
  };

  const firstTextNode = (element) => (
    [...element.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim() !== '') || null
  );

  /*
   * The baseline of the type inside \`element\`.
   *
   * Inside a flex container the probe would become a flex item and stop sharing
   * a line box with the text, so the bare run is first wrapped in a <span> —
   * which is exactly the anonymous flex item the run already generated, and
   * control B is what stops THAT from being an assumption either.
   */
  const baselineOf = (element) => {
    if (!isFlexLike(element)) return probeInto(element);
    const text = firstTextNode(element);
    if (!text) return probeInto(element);
    const wrap = document.createElement('span');
    text.replaceWith(wrap);
    wrap.appendChild(text);
    const baseline = probeInto(wrap);
    wrap.replaceWith(text);
    return baseline;
  };

  // --- Control A: the metric reports zero for two things that ARE level -----
  const a1 = document.querySelector('[data-qa="a1"]');
  const a2 = document.querySelector('[data-qa="a2"]');
  const deltaA = Math.abs(baselineOf(a1) - baselineOf(a2));
  controls.push({
    name: 'identical-runs-measure-level',
    delta: round(deltaA),
    ok: deltaA <= 0.01,
    detail: 'two identical spans on one line',
  });

  // --- Control B: wrapping a run inside a flex row moves nothing ------------
  const rowB = document.getElementById('qa-control-b');
  /*
   * The two ORIGINAL children only. The wrap adds a third, so counting whatever
   * children happen to be there would compare two different lists and always
   * disagree.
   */
  const boxesOf = () => ['b-text', 'b-box'].map((id) => {
    const box = rowB.querySelector('[data-qa="' + id + '"]').getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(round).join(',');
  }).join(' | ');
  const injected = document.createTextNode('Confidence');
  rowB.appendChild(injected);
  const withRun = boxesOf();
  const wrapB = document.createElement('span');
  injected.replaceWith(wrapB);
  wrapB.appendChild(injected);
  const wrapped = boxesOf();
  wrapB.replaceWith(injected);
  injected.remove();
  controls.push({
    name: 'wrapping-a-run-moves-nothing',
    delta: withRun === wrapped ? 0 : 1,
    ok: withRun === wrapped,
    detail: withRun === wrapped ? 'boxes identical: ' + wrapped : withRun + ' -> ' + wrapped,
  });

  // --- The header itself ---------------------------------------------------
  for (const section of document.querySelectorAll('[data-case]')) {
    const name = section.dataset.case;
    const pair = section.querySelector('[data-testid="options-signal-headline-pair"]');
    if (!pair) { problems.push({ case: name, kind: 'missing', detail: 'no headline pair on the card' }); continue; }
    const pairBox = pair.getBoundingClientRect();

    const read = (which) => {
      const label = section.querySelector('[data-testid="options-signal-' + which + '-label"]');
      const value = section.querySelector('[data-testid="options-signal-' + which + '-value"]');
      if (!label || !value) return null;
      const group = value.closest('p');
      const labelBox = label.getBoundingClientRect();
      return {
        label,
        value,
        group,
        labelBox,
        valueBox: value.getBoundingClientRect(),
        groupBox: group.getBoundingClientRect(),
        labelBaseline: baselineOf(label),
        valueBaseline: baselineOf(value),
        lineHeight: parseFloat(getComputedStyle(label).lineHeight),
      };
    };

    const score = read('score');
    const confidence = read('confidence');
    if (!score || !confidence) {
      problems.push({ case: name, kind: 'missing', detail: 'label or value element absent' });
      continue;
    }

    for (const [which, reading] of [['score', score], ['confidence', confidence]]) {
      groups.push({
        case: name,
        group: which,
        top: round(reading.groupBox.top - pairBox.top),
        labelBaseline: round(reading.labelBaseline - pairBox.top),
        valueBaseline: round(reading.valueBaseline - pairBox.top),
        labelHeight: round(reading.labelBox.height),
        labelLineHeight: round(reading.lineHeight),
      });
    }

    // 1 + 2. The two rules the card is actually judged on.
    const labelDelta = Math.abs(score.labelBaseline - confidence.labelBaseline);
    if (labelDelta > BASELINE_TOLERANCE) {
      problems.push({ case: name, kind: 'label-baselines-differ', detail: round(labelDelta) + 'px apart' });
    }
    const valueDelta = Math.abs(score.valueBaseline - confidence.valueBaseline);
    if (valueDelta > BASELINE_TOLERANCE) {
      problems.push({ case: name, kind: 'value-baselines-differ', detail: round(valueDelta) + 'px apart' });
    }

    // 3. The columns start level, told apart from the rows growing.
    const topDelta = Math.abs(score.groupBox.top - confidence.groupBox.top);
    if (topDelta > EDGE_TOLERANCE) {
      problems.push({ case: name, kind: 'groups-start-at-different-levels', detail: round(topDelta) + 'px apart' });
    }

    // 4. Neither label row is taller than the one line of type it holds.
    for (const [which, reading] of [['score', score], ['confidence', confidence]]) {
      if (reading.labelBox.height > reading.lineHeight + EDGE_TOLERANCE) {
        problems.push({
          case: name,
          kind: 'label-row-taller-than-its-line',
          detail: which + ' ' + round(reading.labelBox.height) + 'px against a ' + round(reading.lineHeight) + 'px line',
        });
      }
    }

    // 5. The divider covers both lines, and is painted at all.
    const divider = confidence.group;
    const dividerWidth = parseFloat(getComputedStyle(divider).borderLeftWidth);
    if (!(dividerWidth > 0)) {
      problems.push({ case: name, kind: 'divider-not-painted', detail: 'border-left-width ' + dividerWidth });
    }
    const dividerBox = divider.getBoundingClientRect();
    const highest = Math.min(score.labelBox.top, confidence.labelBox.top);
    const lowest = Math.max(score.valueBox.bottom, confidence.valueBox.bottom);
    if (dividerBox.top > highest + EDGE_TOLERANCE) {
      problems.push({ case: name, kind: 'divider-starts-below-the-labels', detail: round(dividerBox.top - highest) + 'px short' });
    }
    if (dividerBox.bottom < lowest - EDGE_TOLERANCE) {
      problems.push({ case: name, kind: 'divider-ends-above-the-values', detail: round(lowest - dividerBox.bottom) + 'px short' });
    }

    /*
     * 8. The ⓘ is the size the component says it is, and its target is the size
     *    the component says THAT is.
     *
     * InfoHint.test.tsx can only assert the inline style and the class that are
     * supposed to produce this; it cannot see that globals.css gives every button
     * a 44px floor and that a floor beats a height. That is what made the label
     * row 44px, so the rule is written on the icon rather than only on the row it
     * grew.
     */
    const hint = confidence.label.querySelector('button[data-testid^="info-hint-"]');
    if (hint) {
      const hintBox = hint.getBoundingClientRect();
      if (Math.abs(hintBox.height - 18) > EDGE_TOLERANCE || Math.abs(hintBox.width - 18) > EDGE_TOLERANCE) {
        problems.push({
          case: name,
          kind: 'hint-icon-is-not-18px',
          detail: round(hintBox.width) + 'x' + round(hintBox.height),
        });
      }
      const target = getComputedStyle(hint, '::after');
      const targetWidth = parseFloat(target.width);
      const targetHeight = parseFloat(target.height);
      if (!(targetWidth >= 44 - EDGE_TOLERANCE) || !(targetHeight >= 44 - EDGE_TOLERANCE)) {
        problems.push({
          case: name,
          kind: 'hint-tap-target-under-44px',
          detail: round(targetWidth) + 'x' + round(targetHeight),
        });
      }
    }

    // 6. Nothing in the header leaves the card.
    const card = section.querySelector('section[aria-label="Options Signal Engine"]');
    if (card) {
      const cardBox = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const left = cardBox.left + parseFloat(style.paddingLeft);
      const right = cardBox.right - parseFloat(style.paddingRight);
      for (const [which, reading] of [['score', score], ['confidence', confidence]]) {
        for (const [what, box] of [['label', reading.labelBox], ['value', reading.valueBox]]) {
          if (box.left < left - EDGE_TOLERANCE || box.right > right + EDGE_TOLERANCE) {
            problems.push({
              case: name,
              kind: 'header-part-outside-the-card',
              detail: which + ' ' + what + ' [' + round(box.left) + ',' + round(box.right) + '] against [' + round(left) + ',' + round(right) + ']',
            });
          }
        }
      }
    }
  }

  return { controls, groups, problems, documentScrollWidth: document.documentElement.scrollWidth };
}`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = await stylesheet();
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const failures: string[] = [];
  const readings: Array<GroupReading & { at: number }> = [];

  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
      const tab = await context.newPage();
      const html = page(css, width);
      writeFileSync(path.join(OUT_DIR, `header-${width}.html`), html, 'utf8');
      await tab.setContent(html, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);

      const consoleErrors = await tab.evaluate<string[]>('window.__qaErrors || []');
      for (const message of consoleErrors) {
        failures.push(`${width}px · console error · ${message.slice(0, 300)}`);
      }

      // A string handed to `evaluate` is an EXPRESSION, so the probe has to be
      // called rather than merely named.
      const report = await tab.evaluate<HeaderReport>(`(${PROBE})()`);
      await tab.screenshot({ path: path.join(OUT_DIR, `header-${width}.png`), fullPage: true });
      for (const entry of CASES) {
        const pair = tab.locator(`[data-case="${entry.name}"] [data-testid="options-signal-headline-pair"]`);
        if (await pair.count()) {
          await pair.screenshot({ path: path.join(OUT_DIR, `pair-${width}-${entry.name}.png`) });
        }
      }

      /*
       * The controls are read FIRST and they abort rather than accumulate. A
       * measurement method that cannot report zero for two level things does not
       * produce readings worth printing beside the failures it missed.
       */
      for (const control of report.controls) {
        console.log(`    [control] ${width}px · ${control.name} · ${control.ok ? 'ok' : 'FAILED'} · ${control.detail}`);
        if (!control.ok) {
          throw new Error(`measurement control failed at ${width}px: ${control.name} · ${control.detail}`);
        }
      }

      if (report.documentScrollWidth > width) {
        failures.push(`${width}px · document scrolls sideways (${report.documentScrollWidth}px)`);
      }
      for (const problem of report.problems) {
        failures.push(`${width}px · ${problem.case} · ${problem.kind} · ${problem.detail}`);
      }
      readings.push(...report.groups.map((entry) => ({ ...entry, at: width })));

      /*
       * The numbers are PRINTED, not merely asserted. A tolerance nobody can see
       * the margin on is a tolerance that gets widened by whoever trips it next,
       * and these four numbers are the whole subject of the fix.
       */
      for (const entry of CASES) {
        const score = report.groups.find((row) => row.case === entry.name && row.group === 'score');
        const confidence = report.groups.find((row) => row.case === entry.name && row.group === 'confidence');
        if (!score || !confidence) continue;
        console.log(
          `${width}px · ${entry.name}`
          + ` · label baseline ${score.labelBaseline} vs ${confidence.labelBaseline}`
          + ` (Δ${Math.abs(score.labelBaseline - confidence.labelBaseline).toFixed(2)})`
          + ` · value baseline ${score.valueBaseline} vs ${confidence.valueBaseline}`
          + ` (Δ${Math.abs(score.valueBaseline - confidence.valueBaseline).toFixed(2)})`
          + ` · label row ${score.labelHeight} vs ${confidence.labelHeight}`
          + ` on a ${score.labelLineHeight}px line`
          + ` · group top ${score.top} vs ${confidence.top}`,
        );
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  writeFileSync(path.join(OUT_DIR, 'readings.json'), JSON.stringify(readings, null, 2), 'utf8');

  if (failures.length) {
    console.error(`\n${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nclean · ${WIDTHS.length} width(s) × ${CASES.length} case(s) · artifacts in ${OUT_DIR}`);
}

await main();
