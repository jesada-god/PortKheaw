import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KHEAW_LOADER_DELAY_MS,
  KHEAW_LOADER_FADE_MS,
} from '@/src/lib/ui/loading-visibility';

/**
 * The half of the loader that lives in CSS: the grace on route fallbacks, the
 * bounce, and what happens to each of them under reduced motion.
 *
 * Asserted against the stylesheet source, in the manner of
 * `src/themes/portkheaw/auth.contrast.test.ts`, because jsdom does not apply
 * the app's stylesheet and so has no computed value to inspect. The rules these
 * cover are the ones that break silently: a global `*` reset quietly cancelling
 * the grace, or an animation reaching for a property that reflows the page.
 */
const CSS = readFileSync(resolve('app/globals.css'), 'utf8');

/** The declarations of a single rule, by exact selector. */
function rule(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`app/globals.css has no rule for "${selector}"`);
  return CSS.slice(start + selector.length + 3, CSS.indexOf('}', start));
}

function keyframes(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name} {`);
  if (start === -1) throw new Error(`app/globals.css has no @keyframes "${name}"`);
  // Keyframe bodies nest one level, so close on the blank line that follows.
  return CSS.slice(start, CSS.indexOf('\n}', start));
}

describe('Kheaw loader — CSS motion contract', () => {
  it('holds the route fallback invisible for the grace, then fades it in', () => {
    const reveal = rule('.kheaw-loader--deferred');
    const total = KHEAW_LOADER_DELAY_MS + KHEAW_LOADER_FADE_MS;
    expect(reveal).toContain(`kheaw-loader-reveal ${total}ms`);
    // `both` so the hidden first frame applies before the animation starts.
    expect(reveal).toContain('both');

    const frames = keyframes('kheaw-loader-reveal');
    // 300 of 500ms is 60%: everything up to there is hidden outright, which
    // keeps a fast route from painting OR announcing a wait it never had.
    expect(frames).toMatch(/from\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden/);
    expect(frames).toMatch(/60%\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden/);
    expect(frames).toMatch(/to\s*\{\s*opacity:\s*1;\s*visibility:\s*visible/);
    expect(Math.round((KHEAW_LOADER_DELAY_MS / total) * 100)).toBe(60);
  });

  it('fades out over the same window the boundary waits for', () => {
    expect(rule('.kheaw-loader--leaving')).toContain(`kheaw-loader-leave ${KHEAW_LOADER_FADE_MS}ms`);
  });

  it.each([
    'kheaw-mascot-bounce',
    'kheaw-shadow-contact',
    'kheaw-loader-reveal',
    'kheaw-loader-leave',
  ])('animates %s off the compositor, so nothing it does can reflow', (name) => {
    // Anything outside this set — width, height, margin, top — would make the
    // loader's own idle animation shift the layout around it every frame.
    const animated = new Set(
      [...keyframes(name).matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map(([, property]) => property),
    );
    expect(animated.size).toBeGreaterThan(0);
    expect([...animated].filter((property) =>
      !['transform', 'opacity', 'visibility'].includes(property))).toEqual([]);
  });

  it('squashes and stretches around the mascot\'s feet, not its middle', () => {
    expect(rule('.kheaw-loader__mascot')).toContain('transform-origin: 50% 100%');
    const bounce = keyframes('kheaw-mascot-bounce');
    // Landed: wider and flatter. At the top of the arc: narrower and taller.
    expect(bounce).toMatch(/0%,\s*100%\s*\{\s*transform:\s*translateY\(0\)\s*scale\(1\.055,\s*0\.945\)/);
    expect(bounce).toMatch(/46%\s*\{\s*transform:\s*translateY\(-12%\)\s*scale\(0\.975,\s*1\.045\)/);
  });

  it('runs the mascot and its shadow on one 0.9s ease-in-out loop', () => {
    expect(rule('.kheaw-loader__mascot')).toContain('kheaw-mascot-bounce 0.9s ease-in-out infinite');
    expect(rule('.kheaw-loader__shadow')).toContain('kheaw-shadow-contact 0.9s ease-in-out infinite');
    const shadow = keyframes('kheaw-shadow-contact');
    // Wide and stronger on contact, small and fainter at the top of the arc.
    expect(shadow).toMatch(/0%,\s*100%\s*\{\s*transform:\s*scale\(1,\s*1\);\s*opacity:\s*0\.42/);
    expect(shadow).toMatch(/46%\s*\{\s*transform:\s*scale\(0\.7,\s*0\.85\);\s*opacity:\s*0\.15/);
  });

  describe('reduced motion', () => {
    const media = CSS.slice(
      CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  html:not([data-motion-preference="normal"]) .kheaw-loader'),
      CSS.indexOf('html[data-reduce-motion] .kheaw-loader'),
    );
    const attribute = CSS.slice(CSS.indexOf('html[data-reduce-motion] .kheaw-loader'));

    it.each([
      ['media query', media],
      ['data-reduce-motion attribute', attribute],
    ])('stops the bounce via the %s', (_label, block) => {
      expect(block).toContain('.kheaw-loader__mascot');
      expect(block).toContain('.kheaw-loader__shadow');
      expect(block).toMatch(/\.kheaw-loader__shadow\s*\{\s*animation:\s*none\s*!important/);
    });

    it.each([
      ['media query', media],
      ['data-reduce-motion attribute', attribute],
    ])('keeps the grace and the fade at full length via the %s', (_label, block) => {
      // Both out-specify the global `*` reset, which would otherwise collapse
      // these to 0.01ms and bring back the flash for exactly these users.
      expect(block).toContain('.kheaw-loader.kheaw-loader--deferred');
      expect(block).toContain(`animation-duration: ${KHEAW_LOADER_DELAY_MS + KHEAW_LOADER_FADE_MS}ms !important`);
      expect(block).toContain('.kheaw-loader.kheaw-loader--leaving');
      expect(block).toContain(`animation-duration: ${KHEAW_LOADER_FADE_MS}ms !important`);
    });

    it('declares the overrides after the global reset they have to beat', () => {
      expect(CSS.indexOf('.kheaw-loader.kheaw-loader--deferred'))
        .toBeGreaterThan(CSS.indexOf('html[data-reduce-motion] *,'));
    });
  });
});

describe('Kheaw loader — layout and theme contract', () => {
  it('cannot push the page sideways at any width', () => {
    const container = rule('.kheaw-loader');
    expect(container).toContain('max-inline-size: 100%');
    // The bubble is bounded by its container, never by the viewport, so it
    // stays inside whatever card or column it is dropped into.
    expect(rule('.kheaw-loader__bubble')).toContain('max-inline-size: min(22rem, 100%)');
    expect(rule('.kheaw-loader__stage')).toContain('max-inline-size: 100%');
  });

  it('centres the page variant in the viewport, not in a short box', () => {
    // A fixed rem cap here is what puts the mascot two thirds of the way up a
    // tall screen; the page loader has to track the viewport it is centred in.
    expect(rule('.kheaw-loader--page')).toContain('calc(100dvh - 11rem)');
    // …and the section variant must NOT, or a card would grow to fill the page.
    expect(rule('.kheaw-loader--section')).not.toContain('dvh');
  });

  it('sizes the mascot inside the agreed responsive range', () => {
    expect(rule('.kheaw-loader')).toContain('--kheaw-mascot-size: clamp(110px, 34vw, 180px)');
    // 320px and 390px viewports land in the mobile band, desktop hits the cap.
    for (const [viewport, expected] of [[320, 110], [390, 132.6], [1440, 180]] as const) {
      expect(Math.min(180, Math.max(110, viewport * 0.34))).toBeCloseTo(expected, 1);
    }
  });

  it('scales the mascot by width alone, so its aspect ratio survives', () => {
    const mascot = rule('.kheaw-loader__mascot');
    expect(mascot).toContain('inline-size: 100%');
    expect(mascot).toContain('block-size: auto');
  });

  it('takes every colour from a theme token', () => {
    const block = CSS.slice(CSS.indexOf('.kheaw-loader {'), CSS.indexOf('@keyframes kheaw-mascot-bounce'));
    const colours = [...block.matchAll(/(#[0-9A-Fa-f]{3,8}|\brgba?\()/g)];
    expect(colours.map(([match]) => match)).toEqual([]);
    expect(rule('.kheaw-loader')).toContain('var(--surface-elevated)');
    expect(rule('.kheaw-loader')).toContain('var(--text)');
    expect(rule('.kheaw-loader__bubble')).toContain('color: var(--text)');
  });
});
