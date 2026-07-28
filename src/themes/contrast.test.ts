import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locks the PortKheaw palette to WCAG AA. The light appearance is where this
 * bites: the first light accent (#6F8700) read 4.08:1 both as label text on
 * white and as the fill under white button text, and --text-muted read 4.25:1
 * on --surface-elevated. Both were only visible by measuring, not by looking.
 */
function tokens(appearance: 'dark' | 'light'): Record<string, string> {
  const css = readFileSync(resolve(`src/themes/portkheaw/${appearance}.css`), 'utf8');
  return Object.fromEntries(
    [...css.matchAll(/^\s{2}(--[a-z-]+):\s*(#[0-9A-Fa-f]{6});/gm)].map(([, name, hex]) => [name, hex]),
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

const SURFACES = ['--bg', '--surface', '--surface-elevated', '--surface-hover'] as const;
/** Every foreground that carries words, against every surface it can land on. */
const TEXT_ON_SURFACES = ['--text', '--text-secondary', '--text-muted', '--accent'] as const;
/** Market meaning must stay legible in both appearances, never traded for lime. */
const STATUS = ['--positive', '--negative', '--warning', '--info'] as const;

describe.each(['dark', 'light'] as const)('PortKheaw %s contrast', (appearance) => {
  const palette = tokens(appearance);

  it('has every token the checks below need', () => {
    expect(Object.keys(palette).length).toBeGreaterThan(15);
    for (const name of [...SURFACES, ...TEXT_ON_SURFACES, ...STATUS, '--accent-fg', '--border-strong']) {
      expect(`${name}=${palette[name] ?? 'MISSING'}`).toMatch(/#[0-9A-Fa-f]{6}$/);
    }
  });

  it('keeps body and label text at AA on every surface', () => {
    const failures: string[] = [];
    for (const foreground of TEXT_ON_SURFACES) {
      for (const surface of SURFACES) {
        const ratio = contrast(palette[foreground], palette[surface]);
        if (ratio < 4.5) failures.push(`${foreground} on ${surface} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps text on the accent fill at AA', () => {
    expect(contrast(palette['--accent-fg'], palette['--accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps market-direction colours at AA on the card surface', () => {
    const failures: string[] = [];
    for (const status of STATUS) {
      const ratio = contrast(palette[status], palette['--surface']);
      if (ratio < 4.5) failures.push(`${status} on --surface = ${ratio}`);
    }
    expect(failures).toEqual([]);
  });

  // Deliberately below the 3:1 UI-component bar: these borders separate panels,
  // they never carry meaning on their own. The floor just stops a future palette
  // edit from making a card edge vanish into its own surface.
  it('keeps a strong border visible against its surface', () => {
    expect(contrast(palette['--border-strong'], palette['--surface'])).toBeGreaterThanOrEqual(1.4);
  });
});
