import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app shell and controls use semantic tokens directly, but most feature
 * screens still carry the original hardcoded Tailwind palette. `app/globals.css`
 * maps those classes onto the PortKheaw tokens so light mode works everywhere.
 * A class the map does not know about silently keeps its dark palette value —
 * that is how a navy strip ends up across a light page, or `hover:text-white`
 * turns a link invisible on a white surface. This test fails on the next such
 * class instead of waiting for someone to notice it in the browser.
 */
const CLASS_PATTERN = new RegExp(
  String.raw`(?:^|["'\s\`])((?:[a-z-]+:)*(?:bg|text|border|divide|ring|outline)-`
  + String.raw`(?:slate-\d{2,3}|white|black|\[#[0-9A-Fa-f]{3,8}\])`
  + String.raw`(?:\/(?:\[[\d.]+\]|\d{1,3}))?)(?=["'\s\`]|$)`,
  'g',
);

/**
 * Walks the filesystem rather than `git ls-files` on purpose: in-progress work
 * that is not committed yet still renders in the browser, so its classes need
 * the same light-mode cover as everything else.
 */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(resolve(directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) found.push(path);
  }
  return found;
}

function appSources(): string[] {
  return [...sourceFiles('app'), ...sourceFiles('src')];
}

/** Light 100-300 status shades: chosen for a near-black surface, illegible on light. */
const STATUS_TEXT_PATTERN = new RegExp(
  String.raw`(?:^|["'\s\`])(text-(?:rose|sky|emerald|red|amber|blue|purple|violet|green`
  + String.raw`|orange|teal|indigo|pink|cyan|fuchsia|lime)-[1-4]00(?:\/\d{1,3})?)(?=["'\s\`]|$)`,
  'g',
);

function collectClasses(pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const file of appSources()) {
    for (const match of readFileSync(resolve(file), 'utf8').matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function mapped(css: string, token: string): boolean {
  return css.includes(`"${token}"`)
    || new RegExp(String.raw`\.${token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[\s,{]`).test(css);
}

describe('PortKheaw palette compatibility map', () => {
  it('maps every hardcoded palette class the app still ships', () => {
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    const tokens = collectClasses(CLASS_PATTERN);

    expect(tokens.size).toBeGreaterThan(50);
    expect([...tokens].filter((token) => !mapped(css, token)).sort()).toEqual([]);
  });

  it('pairs every variant mapping with the pseudo-class it compiles to', () => {
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    // Tailwind compiles `hover:bg-slate-800/70` to `.hover\:bg-slate-800\/70:hover`,
    // so a mapping only lands on the same elements if it carries the pseudo-class
    // too. `[class*="bg-slate-800/"]` would match the hover class as a substring
    // and pin the hover background on permanently — hence `~=` plus the pseudo.
    const expected: Record<string, string> = {
      'hover:': ':hover',
      'focus:': ':focus',
      'focus-visible:': ':focus-visible',
      'placeholder:': '::placeholder',
    };

    expect(css).not.toMatch(/\[class\*=/);

    const seen = new Set<string>();
    for (const [, token, pseudo] of css.matchAll(/\[class~="([a-z-]+:[^"]+)"\]([^\s{,]*)/g)) {
      const variant = `${token.split(':')[0]}:`;
      if (!(variant in expected)) continue;
      seen.add(variant);
      expect(`${token} => ${pseudo}`).toBe(`${token} => ${expected[variant]}`);
    }
    expect([...seen].sort()).toEqual(['focus-visible:', 'focus:', 'hover:', 'placeholder:']);

    // group-hover only fires from an ancestor, so it must be an ancestor selector.
    expect(css).toMatch(/\.group:hover \[class~="group-hover:[^"]+"\]/);
  });

  it('covers every mapping category the app relies on', () => {
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    const categories: Record<string, RegExp> = {
      'plain utility': /\.bg-slate-950 \{ background-color: var\(--bg\)/,
      'opacity modifier': /\[class~="bg-slate-900\/30"\][\s\S]{0,240}?color-mix\(in srgb, var\(--surface-elevated\)/,
      'arbitrary hex': /\[class~="bg-\[#151B28\]"\]/,
      'arbitrary hex + opacity': /\[class~="bg-\[#0A0E17\]\/95"\][\s\S]{0,120}?var\(--bg\)/,
      text: /\.text-white[^{]*\{ color: var\(--text\)/,
      border: /\.border-slate-800[^{]*\{ border-color: var\(--border\)/,
      background: /\.bg-white \{ background-color: var\(--surface\)/,
      divide: /divide-slate-800[^{]*> :not\(:last-child\) \{ border-color: var\(--border\)/,
      placeholder: /\[class~="placeholder:text-slate-500"\]::placeholder \{ color: var\(--text-muted\)/,
      ring: /--tw-ring-color: var\(--accent\)/,
      gradient: /background-image: linear-gradient\([^)]*var\(--surface\), var\(--bg\)\)/,
    };

    expect(
      Object.entries(categories)
        .filter(([, pattern]) => !pattern.test(css))
        .map(([name]) => name),
    ).toEqual([]);
  });

  it('resolves every mapped token in both PortKheaw appearances', () => {
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    /*
     * Properties globals.css declares for itself. A component-scoped variable
     * derived from the tokens — `--kheaw-shadow-color` is a color-mix over
     * `--text` — resolves identically in both appearances by construction, so
     * requiring the theme files to declare it would mean duplicating one value
     * per appearance and inviting them to drift.
     */
    const local = new Set(
      [...css.matchAll(/^\s{2}(--[a-z-]+):/gm)].map((match) => match[1]),
    );
    const referenced = new Set(
      [...css.matchAll(/var\((--[a-z-]+)\)/g)]
        .map((match) => match[1])
        // Tailwind supplies its own --tw-* and --color-* variables.
        .filter((name) => !name.startsWith('--tw-') && !name.startsWith('--color-'))
        .filter((name) => !local.has(name)),
    );

    expect(referenced.size).toBeGreaterThan(15);
    for (const file of ['src/themes/portkheaw/dark.css', 'src/themes/portkheaw/light.css']) {
      const declared = new Set(
        [...readFileSync(resolve(file), 'utf8').matchAll(/^\s{2}(--[a-z-]+):/gm)].map((m) => m[1]),
      );
      expect(`${file}: ${[...referenced].filter((name) => !declared.has(name)).sort()}`)
        .toBe(`${file}: `);
    }
  });

  it('keeps light-shade status text readable on the light surface', () => {
    // 100-300 shades were chosen to glow on near-black; on the light surface
    // they land around 2:1. Each one needs a light-mode mapping, and the market
    // families must keep their meaning rather than inherit the brand lime.
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    const lightBlock = css.slice(css.indexOf('html[data-appearance="light"]'));
    const used = collectClasses(STATUS_TEXT_PATTERN);

    expect(used.size).toBeGreaterThan(15);
    expect([...used].filter((token) => !mapped(lightBlock, token) && !mapped(css, token)).sort())
      .toEqual([]);

    const marketFamilies = /\.text-(?:emerald|green|red|rose|amber|orange|sky|blue)-[1-4]00[^{]*\{ color: ([^;]+);/g;
    for (const [, value] of lightBlock.matchAll(marketFamilies)) {
      expect(value).toMatch(/var\(--(?:positive|negative|warning|info)\)/);
    }
  });

  it('targets only class names Tailwind can actually emit', () => {
    /*
     * Deliberately NOT asserting "every mapping is used". The map is shared
     * infrastructure: a generic utility such as `border-white/10` may be mapped
     * in one commit and consumed by a feature that lands in the next, so an
     * unused mapping is inert CSS rather than a defect. What is a defect is a
     * mapping aimed at a class Tailwind will never produce — `bg-slate-85`, a
     * mistyped hex, an invented `hovered:` variant — because it reads as cover
     * while the real class stays unmapped. That is what this checks.
     */
    const css = readFileSync(resolve('app/globals.css'), 'utf8');
    const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const VARIANTS = ['hover', 'focus', 'focus-visible', 'group-hover', 'placeholder', 'md'];
    const PROPERTIES = [
      'bg', 'text', 'border', 'divide', 'ring', 'outline', 'accent',
      'from', 'via', 'to', // gradient stops
    ];

    const wellFormed = (token: string): boolean => {
      const parts = token.split(':');
      const utility = parts.pop() as string;
      if (!parts.every((variant) => VARIANTS.includes(variant))) return false;

      const [, property, rest] = /^([a-z-]+?)-(.+)$/.exec(utility) ?? [];
      if (!PROPERTIES.includes(property)) return false;

      const [value, opacity] = rest.split('/');
      if (opacity !== undefined && !/^(?:\d{1,3}|\[[\d.]+\])$/.test(opacity)) return false;

      if (value === 'white' || value === 'black' || value === 'current') return true;
      if (/^\[#[0-9A-Fa-f]{3,8}\]$/.test(value)) return true;
      const [, shade] = /^[a-z]+-(\d{2,3})$/.exec(value) ?? [];
      return shade !== undefined && SHADES.includes(Number(shade));
    };

    const mappedTokens = [...new Set(
      [...css.matchAll(/\[class~="([^"]+)"\]/g)].map((match) => match[1]),
    )];

    expect(mappedTokens.length).toBeGreaterThan(30);
    expect(mappedTokens.filter((token) => !wellFormed(token)).sort()).toEqual([]);
  });
});
