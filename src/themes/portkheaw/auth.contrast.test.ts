import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Holds the authentication palette to WCAG AA in both appearances.
 *
 * The auth pages are the one place in the product with a saturated green field
 * behind white text and a filled green button under white text — the two
 * combinations that look right and measure wrong. `--auth-primary` in the light
 * appearance is the sharpest case: the obvious brand green (#4CAF50) reads about
 * 2.8:1 under white, which is why the token is a darker green instead.
 */
const CSS = readFileSync(resolve('src/themes/portkheaw/auth.css'), 'utf8');

function tokens(appearance: 'light' | 'dark'): Record<string, string> {
  const block = appearance === 'light'
    ? CSS.slice(CSS.indexOf('[data-auth-shell] {'), CSS.indexOf('html[data-appearance="dark"]'))
    : CSS.slice(CSS.indexOf('html[data-appearance="dark"] [data-auth-shell] {'));
  return Object.fromEntries(
    [...block.matchAll(/^\s{2}(--[a-z-]+):\s*(#[0-9A-Fa-f]{6});/gm)].map(([, name, hex]) => [name, hex]),
  );
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(1)) + (0.7152 * channel(3)) + (0.0722 * channel(5));
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

describe.each(['light', 'dark'] as const)('PortKheaw auth palette (%s)', (appearance) => {
  const palette = tokens(appearance);

  it('defines every token the pages reference', () => {
    for (const name of [
      '--auth-field-top', '--auth-field-mid', '--auth-field-bottom', '--auth-decor',
      '--auth-on-field', '--auth-on-field-muted',
      '--auth-card', '--auth-card-soft', '--auth-card-border',
      '--auth-text', '--auth-text-secondary', '--auth-text-muted',
      '--auth-input-bg', '--auth-input-border', '--auth-input-text',
      '--auth-primary', '--auth-primary-fg', '--auth-focus', '--auth-success',
    ]) {
      expect(`${appearance} ${name}`).toBe(`${appearance} ${name}`);
      expect(palette[name]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('keeps every card text tone readable on the card and on the soft panel', () => {
    for (const surface of ['--auth-card', '--auth-card-soft', '--auth-input-bg'] as const) {
      for (const text of ['--auth-text', '--auth-text-secondary', '--auth-text-muted'] as const) {
        expect(`${text} on ${surface}: ${contrast(palette[text], palette[surface])}`)
          .toBe(`${text} on ${surface}: ${contrast(palette[text], palette[surface])}`);
        expect(contrast(palette[text], palette[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the primary button label readable on its own fill', () => {
    expect(contrast(palette['--auth-primary-fg'], palette['--auth-primary'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps link and success text readable on the card', () => {
    for (const tone of ['--auth-primary', '--auth-success'] as const) {
      expect(contrast(palette[tone], palette['--auth-card'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps text on the green field readable against every stop of the gradient', () => {
    for (const stop of ['--auth-field-top', '--auth-field-mid', '--auth-field-bottom'] as const) {
      expect(contrast(palette['--auth-on-field'], palette[stop])).toBeGreaterThanOrEqual(4.5);
      // The muted tone carries the tagline and benefit captions — still body text.
      expect(contrast(palette['--auth-on-field-muted'], palette[stop])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the decorative artwork tone distinguishable without pretending it is text', () => {
    // The candlesticks are decoration, so the 3:1 non-text bar is what applies.
    expect(contrast(palette['--auth-decor'], palette['--auth-field-mid'])).toBeGreaterThanOrEqual(3);
  });

  it('keeps the focus ring visible against the surfaces focus lands on', () => {
    expect(contrast(palette['--auth-focus'], palette['--auth-card'])).toBeGreaterThanOrEqual(3);
    expect(contrast(palette['--auth-focus'], palette['--auth-input-bg'])).toBeGreaterThanOrEqual(3);
  });

  it('keeps the input border visible enough to read as a field boundary', () => {
    expect(contrast(palette['--auth-input-border'], palette['--auth-card'])).toBeGreaterThanOrEqual(1.4);
  });
});

describe('auth motion', () => {
  it('runs every animation only when reduced motion has not been requested', () => {
    const motionBlock = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const rule of ['auth-decor-drift', 'auth-rise']) {
      // The animation is *applied* inside the guarded block...
      expect(motionBlock).toContain(`animation: ${rule}`);
      // ...and never applied outside it.
      const beforeGuard = CSS.slice(0, CSS.indexOf('@media (prefers-reduced-motion: no-preference)'));
      expect(beforeGuard).not.toContain(`animation: ${rule}`);
    }
  });

  it('animates only compositor-friendly properties', () => {
    const keyframes = CSS.slice(CSS.indexOf('@keyframes auth-decor-drift'));
    expect(keyframes).toContain('transform');
    for (const expensive of ['width:', 'height:', 'top:', 'left:', 'margin']) {
      expect(keyframes).not.toContain(expensive);
    }
  });
});
