/**
 * The zone bar, measured in a real browser at the width most readers are on.
 *
 * `MarketSignalSection.test.tsx` can only assert the ABSENCE of classes that cut
 * a line — jsdom has no layout engine, so it cannot tell you that a label three
 * pixels wider than its field is now sitting on top of the next one. This does
 * the other half: it renders the real component to HTML, compiles the app's real
 * stylesheet over it, and asks Chrome for the boxes.
 *
 * The cards are HYDRATED here, not merely rendered. The bar decides whether two
 * captions can stand apart by measuring the boxes it drew, so the arrangement
 * in server markup is only the one it falls back to having measured nothing —
 * a probe pointed at that would be checking the fallback and reporting on the
 * picture. The component is bundled for the browser, hydrated over the same
 * markup, and measured after its layout effect has run.
 *
 * It is deliberately NOT the full-page QA (`npm run qa:ui-redesign-auth`), which
 * needs a server and a signed-in Elite account. This mounts one component in one
 * page-width container, so it runs offline, in seconds, on any machine with
 * Chrome, and it fails on the specific thing the redesign could break: a piece
 * of the bar leaving the bar.
 *
 * What it checks, per case, per width:
 *   1. nothing in the card extends past the card's own content box
 *   2. all three zone fields have real width; a field carries its name when it
 *      is wider than the name and goes unnamed when it is not, and a name that
 *      is drawn never overlaps into the field beside it
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
 *  12. every row of the zone block starts where the track starts and finishes
 *      where the track finishes, within 2px, and nothing in the block reaches
 *      past either end. This is the rule the two-column trigger grid broke: its
 *      right-hand cell ran out at about 70% of the block, so a sentence about
 *      the top of the frame ended in the middle of nowhere
 *  13. the block fills the card's content box exactly — same gap on the left as
 *      on the right, both of them the card's own padding. The 640px cap this
 *      replaced answered a wide-screen complaint by shrinking the picture, which
 *      left phone-sized type marooned in a two-thirds-width block; the fix is
 *      that the DRAWING scales, checked by 15 below
 *  14. two field names that sit beside each other keep at least 12px of clear
 *      air. "กรอบเดิม" used to be shoved against whichever end of its field the
 *      marker was not on, so it ended up touching "ขาลง", which is beside it
 *      rather than on top of it and invisible to the overlap rule
 *  15. THE TYPE GROWS WITH THE TRACK. Every kind of type on the picture — field
 *      names, edge prices, price captions — and the bar's own height are
 *      compared between 390px and 1440px, and each one has to be strictly
 *      larger at the wide width. A cap plus fixed type is the arrangement this
 *      replaced, and nothing about it was visible at one width alone
 *  16. nothing on the page logged a console error, which is how a hydration
 *      mismatch — the two halves of this harness drawing two different cards —
 *      would show up
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import { CASES } from './market-signal-zone-bar-cases';

/*
 * The project compiles JSX with the classic runtime, so the components reach
 * `React.createElement` through a global rather than through an import of their
 * own. `MarketSignalSection.test.tsx` stubs the same global for the same reason.
 */
(globalThis as { React?: typeof React }).React = React;

const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/market-signal-zone-bar';

/**
 * 390x844 is the brief and the two narrower ones are the margin of safety.
 * 1280 is the width the bar was WRONG at: stretched across a desktop card it
 * put a hand's width between a caption and the line it named, and — because the
 * layout used to answer "do these two collide" on a hypothetical 216px track —
 * it merged captions that had 90px of clear air between them. Nothing about
 * that was visible at 390.
 */
const WIDTHS = [1440, 1280, 390, 360, 320];
/**
 * The two widths the font-scale rule is read off, and it is a rule about a
 * PAIR: "the caption is 14px at 1440" is a number somebody can satisfy by
 * hard-coding 14px everywhere. What the bar has to do is grow, so the assertion
 * is that every kind of type on the picture measures strictly more at the wide
 * width than at the phone width, and the bar with it.
 */
const SCALE_FROM = 390;
const SCALE_TO = 1440;
/** Nothing in the block may start or end more than this far from the track. */
const ROW_ALIGN_TOLERANCE = 2;
/**
 * The clear air two ADJACENT field names have to keep, mirroring
 * `NAME_MIN_GAP_PX` in the component.
 *
 * The bug: the middle field's name was pushed hard against whichever end of its
 * own field the close marker was not standing in, and the outer names are
 * written against the cuts, so "กรอบเดิม" ended up touching "ขาลง" — two
 * different claims about two different price ranges reading as one run of Thai.
 * The overlap rule above could not see it, because the two boxes were beside
 * each other rather than on top of each other.
 */
const NAME_MIN_GAP_PX = 12;
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

async function stylesheet(): Promise<string> {
  const from = path.resolve('app/globals.css');
  const source = await readFile(from, 'utf8');
  const compiled = await postcss([tailwind()]).process(source, { from });
  return compiled.css;
}

function markup(entry: (typeof CASES)[number]): string {
  // `renderToString`, not `renderToStaticMarkup`: this markup gets hydrated, and
  // static markup drops the text-node boundaries hydration matches against.
  return renderToString(
    React.createElement(
      EntitlementProvider,
      { tier: 'elite', authenticated: true, trialOffer: 'used' },
      React.createElement(MarketSignalSection, { result: entry.result, livePrice: entry.livePrice }),
    ),
  );
}

/**
 * The same cards, bundled for the browser so they can be hydrated there.
 *
 * Without this the page is a photograph: the caption arrangement in the markup
 * is the one the card falls back to when nothing has been measured, and the
 * whole point of the rebuild is that the real arrangement is decided from
 * measured boxes. Bundling the component and running it means the boxes this
 * probe measures are the boxes a reader gets.
 */
async function clientBundle(): Promise<string> {
  const built = await build({
    entryPoints: [path.resolve('scripts/qa/market-signal-zone-bar-client.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    target: 'es2022',
    /*
     * The card reaches config that reads `process.env`, and a browser has no
     * `process`. Defined rather than shimmed so the bundle carries the same
     * flag state the server render used: every SIGNAL_* flag off.
     */
    define: {
      'process.env.NODE_ENV': '"development"',
    },
    banner: { js: 'globalThis.process = globalThis.process || { env: { NODE_ENV: "development" } };' },
    alias: { '@': process.cwd(), 'server-only': path.resolve('src/test/server-only-stub.ts') },
    logLevel: 'silent',
  });
  return built.outputFiles[0].text;
}

function page(css: string, script: string, width: number, appearance: (typeof APPEARANCES)[number]): string {
  const cards = CASES.map((entry) => `
    <section data-case="${entry.name}" data-markers-apart="${entry.markersApart ? 'true' : 'false'}" data-live="${entry.livePrice === null ? 'false' : 'true'}" style="width:${width}px;padding:0 ${PAGE_PADDING}px;margin:0 auto 24px;">
      <p style="font:12px monospace;color:#64748b;margin:0 0 6px;">${entry.name} @ ${width}px</p>
      <div data-hydrate="${entry.name}">${markup(entry)}</div>
    </section>`).join('');
  const ground = appearance === 'light' ? '#F6F7F9' : '#0B0F17';
  return `<!doctype html><html lang="th" data-theme="portkheaw" data-appearance="${appearance}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:${ground};} body{overflow-x:hidden;}</style>
</head><body>${cards}
<script>window.__qaErrors = [];
addEventListener('error', (event) => window.__qaErrors.push(String(event.message)));
const consoleError = console.error;
console.error = (...args) => { window.__qaErrors.push(args.map(String).join(' ')); consoleError(...args); };
</script>
<script>${script}</script>
</body></html>`;
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
/**
 * One rendered size, so the same thing can be compared between two widths.
 * `what` is a KIND of element rather than one node, because which nodes exist
 * depends on the case: a field too narrow for its name has no name to measure.
 */
interface ScaleReading { what: string; px: number }
interface ZoneBarReport {
  problems: ZoneBarProblem[];
  markers: MarkerReading[];
  widths: WidthReading[];
  scale: ScaleReading[];
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
  const NAME_MIN_GAP_PX = ${NAME_MIN_GAP_PX};
  const ROW_ALIGN_TOLERANCE = ${ROW_ALIGN_TOLERANCE};
  const problems = [];
  const markers = [];
  const widths = [];
  const scale = [];
  const seenScale = new Set();
  /*
   * One reading per KIND, taken off the first case that draws one. Every case
   * on the page is at the same width and therefore at the same size, so a
   * second reading of the same kind adds nothing; and taking the first means
   * the comparison between two widths is between the same two elements.
   */
  const measureScale = (what, px) => {
    if (!(px > 0) || seenScale.has(what)) return;
    seenScale.add(what);
    scale.push({ what, px: Number(px.toFixed(2)) });
  };
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
      /*
       * A field carries its name when it has room for it, and not otherwise.
       *
       * Both halves are failures. A named field too narrow for the name spills
       * the word into the field beside it, where it names the wrong thing; an
       * unnamed field that had room is a word the reader was owed. The width
       * compared against is the one the bar itself measured — the invisible copy
       * it lays out from — so the rule here and the rule in the component are
       * the same rule rather than two guesses that happen to agree.
       */
      const label = field.querySelector('[data-label]');
      const nameProbe = bar.querySelector('[data-measure="zone-' + field.dataset.zone + '"]');
      const nameWidth = nameProbe ? nameProbe.getBoundingClientRect().width : 0;
      /*
       * The middle field asks for more room than the other two, and the
       * component asks for exactly the same: its name is always centred and it
       * has a name on BOTH sides of it, so it needs \`NAME_MIN_GAP_PX\` of clear
       * air twice over before it can be drawn at all. The outer two are bounded
       * by the ends of the bar on their far side and need only to fit.
       */
      const clearance = field.dataset.zone === 'sideways' ? NAME_MIN_GAP_PX * 2 : 2;
      if (!label) {
        if (nameWidth > 0 && box.width > nameWidth + clearance + TOLERANCE) {
          note(name, 'field-unnamed', field.dataset.zone + ' is ' + box.width.toFixed(1)
            + 'px and its name only ' + nameWidth.toFixed(1) + 'px');
        }
        continue;
      }
      measureScale('zone-name-font', parseFloat(getComputedStyle(label).fontSize));
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

    /*
     * AND THE FIELD NAMES KEEP THEIR DISTANCE.
     *
     * Not overlapping is not enough for these three: they are three different
     * claims about three different price ranges, written in the same face at
     * the same size and sitting in one row, so two of them a pixel apart read
     * as one Thai word. The rule that produced the bug pushed the middle name
     * against whichever end of its field the marker was not standing in, and
     * the outer names are written against the cuts, so "กรอบเดิม" finished
     * flush against "ขาลง" with the overlap rule above reporting nothing.
     *
     * Adjacent in DRAWN order rather than in field order: a field too narrow
     * for its name has none, and the two names either side of it are then the
     * adjacent pair.
     */
    const drawnNames = [...bar.querySelectorAll('[data-zone] [data-label]')]
      .map((node) => ({ key: node.getAttribute('data-label'), text: (node.textContent || '').trim(), box: node.getBoundingClientRect() }))
      .sort((a, b) => a.box.left - b.box.left);
    for (let i = 1; i < drawnNames.length; i += 1) {
      const left = drawnNames[i - 1];
      const right = drawnNames[i];
      const gap = right.box.left - left.box.right;
      if (gap < NAME_MIN_GAP_PX - TOLERANCE) {
        note(name, 'zone-names-too-close',
          left.key + ' "' + left.text + '" and ' + right.key + ' "' + right.text + '" are '
          + gap.toFixed(1) + 'px apart, under ' + NAME_MIN_GAP_PX + 'px');
      }
    }

    const barRow = bar.querySelector('[data-track="bar"]');
    const barBox = barRow ? barRow.getBoundingClientRect() : null;
    if (!barRow) note(name, 'missing-bar-row', 'the bar itself is not marked as a track');

    /*
     * THE ALIGNMENT RULE.
     *
     * Every row of the zone block starts where the track starts and finishes
     * where the track finishes. The row that produced this rule was a
     * two-column grid: its right-hand cell began at 50% of the block and ran out
     * at about 70%, so "ถ้าปิดเหนือ 43.23 · ถือว่าเข้าโซนขาขึ้น" ended in the
     * middle of nowhere with a third of the block empty beside it, and nothing
     * about it said which end of the bar it was talking about. That row is gone,
     * but the class of bug is not: any row that does not run the full width of
     * the track is a row a reader cannot pair with the picture.
     *
     * Checked against the TRACK rather than against the card, because the track
     * is what the picture is drawn on and the only edge a caption or an edge
     * price can be lined up with.
     */
    if (barBox) {
      const rows = [...bar.querySelectorAll('[data-zone-row]')];
      if (rows.length === 0) note(name, 'no-zone-rows', 'no row of the block is marked for measuring');
      for (const row of rows) {
        const box = row.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const left = box.left - barBox.left;
        const right = box.right - barBox.right;
        if (Math.abs(left) > ROW_ALIGN_TOLERANCE || Math.abs(right) > ROW_ALIGN_TOLERANCE) {
          note(name, 'row-not-aligned-with-track',
            row.getAttribute('data-zone-row') + ' spans ' + box.left.toFixed(1) + '-' + box.right.toFixed(1)
            + ' against a track of ' + barBox.left.toFixed(1) + '-' + barBox.right.toFixed(1)
            + ' (' + left.toFixed(1) + ' / ' + right.toFixed(1) + ')');
        }
      }

      /*
       * And nothing unmarked wanders outside them either — a row that forgot
       * its attribute would otherwise be invisible to the rule above.
       */
      for (const node of bar.querySelectorAll('*')) {
        const style = getComputedStyle(node);
        if (style.position !== 'static' || style.display === 'inline') continue;
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.left < barBox.left - ROW_ALIGN_TOLERANCE || box.right > barBox.right + ROW_ALIGN_TOLERANCE) {
          note(name, 'zone-block-overflows-track',
            node.className + ' :: ' + (node.textContent || '').slice(0, 30)
            + ' spans ' + box.left.toFixed(1) + '-' + box.right.toFixed(1));
        }
      }

      /*
       * THE BLOCK IS THE CARD, EDGE TO EDGE.
       *
       * It used to be capped at 640px and centred, which read on a desktop as a
       * small drawing pushed into the middle of a large card with a hand's
       * width of empty card either side and phone-sized type on it. The cap is
       * gone; what replaces it is that the block fills the card's CONTENT box —
       * so the gap on the left is the card's padding and the gap on the right
       * is the same padding, by construction rather than by arithmetic — and
       * the type on it grows with the track (see the scale readings below).
       *
       * Both edges are checked, not just the difference between them: a block
       * that is 20px short on each side is perfectly centred and still wrong.
       */
      const blockBox = bar.getBoundingClientRect();
      const cardStyle = getComputedStyle(card);
      const contentLeft = cardBox.left + parseFloat(cardStyle.borderLeftWidth) + parseFloat(cardStyle.paddingLeft);
      const contentRight = cardBox.right - parseFloat(cardStyle.borderRightWidth) - parseFloat(cardStyle.paddingRight);
      const leftGap = blockBox.left - contentLeft;
      const rightGap = contentRight - blockBox.right;
      if (Math.abs(leftGap) > ROW_ALIGN_TOLERANCE || Math.abs(rightGap) > ROW_ALIGN_TOLERANCE) {
        note(name, 'zone-block-not-full-width',
          'the block leaves ' + leftGap.toFixed(1) + 'px on the left and ' + rightGap.toFixed(1)
          + 'px on the right of the card content box');
      }
      measureScale('bar-height', barBox.height);
    }

    const markX = (which) => {
      const node = bar.querySelector('[data-marker="' + which + '"]') || bar.querySelector('[data-cut="' + which + '"]');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return (box.left + box.right) / 2;
    };

    for (const label of labels) {
      const font = parseFloat(getComputedStyle(label.node).fontSize);
      if (label.key === 'close' || label.key === 'live' || label.key === 'prices') measureScale('price-caption-font', font);
      if (label.key.indexOf('edge') === 0 || label.key === 'edges') measureScale('edge-price-font', font);

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

  return { problems, markers, widths, scale, documentScrollWidth: document.documentElement.scrollWidth };
}`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = await stylesheet();
  const script = await clientBundle();
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const failures: string[] = [];
  const readings: Array<MarkerReading & { at: string }> = [];
  const labelWidths: Array<WidthReading & { at: string }> = [];
  /** appearance -> width -> kind -> rendered px, for the growth rule below. */
  const scaleByWidth = new Map<string, Map<number, Map<string, number>>>();

  try {
    for (const appearance of APPEARANCES) {
    for (const width of WIDTHS) {
      const tag = `${appearance}-${width}`;
      const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
      const tab = await context.newPage();
      const html = page(css, script, width, appearance);
      writeFileSync(path.join(OUT_DIR, `zone-bar-${tag}.html`), html, 'utf8');
      await tab.setContent(html, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);
      /*
       * Nothing is measured until React is running on the page: the markup the
       * server produced is the arrangement the bar falls back to when it has
       * measured nothing, and probing that would be probing the fallback.
       */
      await tab.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', undefined, { timeout: 20_000 });
      await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // A hydration mismatch means the two halves of this harness are drawing
      // two different cards, which would make every measurement below a
      // measurement of the wrong one.
      const consoleErrors = await tab.evaluate<string[]>('window.__qaErrors || []');
      for (const message of consoleErrors) {
        failures.push(`${tag} · console error · ${message.slice(0, 300)}`);
      }

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
      const perAppearance = scaleByWidth.get(appearance) ?? new Map<number, Map<string, number>>();
      perAppearance.set(width, new Map(report.scale.map((entry) => [entry.what, entry.px])));
      scaleByWidth.set(appearance, perAppearance);
      await context.close();
    }
    }
  } finally {
    await browser.close();
  }

  /*
   * THE GROWTH RULE, which needs two widths and therefore cannot live in the
   * probe.
   *
   * Removing the 640px cap on its own would make the bar worse, not better: the
   * complaint the cap was answering is that a wide bar puts distance between a
   * caption and the line it names, and distance with unchanged 12px type is a
   * caption that has shrunk relative to everything around it. So the cap and
   * the scaling are one change, and this is the half of it a single width
   * cannot see. Strictly greater, in every kind, in both appearances.
   */
  const scaleFailures: string[] = [];
  for (const appearance of APPEARANCES) {
    const narrow = scaleByWidth.get(appearance)?.get(SCALE_FROM);
    const wide = scaleByWidth.get(appearance)?.get(SCALE_TO);
    if (!narrow || !wide) {
      scaleFailures.push(`${appearance} · no readings at ${SCALE_FROM}px or ${SCALE_TO}px to compare`);
      continue;
    }
    for (const [what, narrowPx] of narrow) {
      const widePx = wide.get(what);
      if (widePx === undefined) {
        scaleFailures.push(`${appearance} · ${what} is drawn at ${SCALE_FROM}px but not at ${SCALE_TO}px`);
      } else if (!(widePx > narrowPx)) {
        scaleFailures.push(
          `${appearance} · ${what} does not grow with the track: ${narrowPx}px at ${SCALE_FROM}`
          + ` and ${widePx}px at ${SCALE_TO}`,
        );
      } else {
        console.log(`${appearance} · ${what} ${narrowPx}px @${SCALE_FROM} → ${widePx}px @${SCALE_TO}`);
      }
    }
  }
  failures.push(...scaleFailures);

  writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({
    widths: WIDTHS,
    appearances: APPEARANCES,
    cases: CASES.map((entry) => entry.name),
    markerMinContrast: MARKER_MIN_CONTRAST,
    markerMinGap: MARKER_MIN_GAP,
    markers: readings,
    labelWidths,
    scale: Object.fromEntries([...scaleByWidth].map(([appearance, byWidth]) => [
      appearance,
      Object.fromEntries([...byWidth].map(([width, kinds]) => [width, Object.fromEntries(kinds)])),
    ])),
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
