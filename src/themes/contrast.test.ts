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

/** Hue in degrees. Used to prove a session tone is not a market-direction colour. */
function hueOf(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  if (delta === 0) return 0;
  const hue = max === red
    ? 60 * ((((green - blue) / delta) % 6 + 6) % 6)
    : max === green
      ? 60 * ((blue - red) / delta + 2)
      : 60 * ((red - green) / delta + 4);
  return Math.round((hue + 360) % 360);
}

/** Shortest angular distance between two hues, 0°–180°. */
function hueSeparation(left: string, right: string): number {
  const delta = Math.abs(hueOf(left) - hueOf(right)) % 360;
  return Math.min(delta, 360 - delta);
}

const SURFACES = ['--bg', '--surface', '--surface-elevated', '--surface-hover'] as const;
/** Every foreground that carries words, against every surface it can land on. */
const TEXT_ON_SURFACES = ['--text', '--text-secondary', '--text-muted', '--accent'] as const;
/** Market meaning must stay legible in both appearances, never traded for lime. */
const STATUS = ['--positive', '--negative', '--warning', '--info'] as const;
/** Market-session icon tones. Meaningful graphics, so the 3:1 bar applies. */
const SESSION_TONES = [
  '--session-pre',
  '--session-regular',
  '--session-post',
  '--session-closed',
  '--session-event',
] as const;
/** Plan and role badge tones. They colour words, so the 4.5:1 text bar applies. */
const IDENTITY_TONES = [
  '--plan-basic',
  '--plan-pro',
  '--plan-elite',
  '--plan-elite-trial',
  '--role-admin',
] as const;

describe.each(['dark', 'light'] as const)('PortKheaw %s contrast', (appearance) => {
  const palette = tokens(appearance);

  it('has every token the checks below need', () => {
    expect(Object.keys(palette).length).toBeGreaterThan(15);
    for (const name of [...SURFACES, ...TEXT_ON_SURFACES, ...STATUS, ...SESSION_TONES, ...IDENTITY_TONES, '--accent-fg', '--border-strong']) {
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

  /**
   * Market-session icon tones.
   *
   * 3:1 is the WCAG bar for a non-text graphic that carries meaning, and these do:
   * the glyph tells a reader which session the price belongs to. The light
   * appearance is where this bites — the dark tones read barely 2:1 on white, which
   * is exactly how a session icon becomes invisible in light mode.
   */
  it('keeps every session icon tone at the 3:1 graphic bar on every surface', () => {
    const failures: string[] = [];
    for (const tone of SESSION_TONES) {
      for (const surface of SURFACES) {
        const ratio = contrast(palette[tone], palette[surface]);
        if (ratio < 3) failures.push(`${tone} on ${surface} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * A session icon must never be mistakable for a price direction.
   *
   * The separation that matters here is HUE, not luminance: gain green and loss red
   * are read as hues, and a session tone at the same hue would say "up"/"down"
   * whatever its brightness. 25° is comfortably outside the just-noticeable range at
   * icon size, and every tone clears it — including the deliberately warm closure
   * tone, which sits at orange rather than red for exactly this reason.
   */
  it('keeps every session tone at least 25° of hue from gain and loss', () => {
    const failures: string[] = [];
    for (const tone of SESSION_TONES) {
      for (const direction of ['--positive', '--negative'] as const) {
        expect(palette[tone]).not.toBe(palette[direction]);
        const separation = hueSeparation(palette[tone], palette[direction]);
        if (separation < 25) failures.push(`${tone} vs ${direction} = ${separation}°`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * Plan and role badges.
   *
   * A badge is a word in its identity tone on a tinted wash of the same tone,
   * which resolves to very close to the surface underneath. So the bar is the
   * text bar, on every surface a card can sit on — and the light appearance is
   * again where it bites: the dark tones read around 1.5:1 on white.
   */
  it('keeps every plan and role badge tone at AA on every surface', () => {
    const failures: string[] = [];
    for (const tone of IDENTITY_TONES) {
      for (const surface of SURFACES) {
        const ratio = contrast(palette[tone], palette[surface]);
        if (ratio < 4.5) failures.push(`${tone} on ${surface} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The operator role must never be mistakable for a plan. Admin is a crimson
   * and every plan tone is green, teal or gold, so the separation is in hue and
   * survives both appearances. Gold is the near neighbour, which is what sets
   * the ceiling on how far toward pure red this tone may travel.
   */
  it('keeps the admin tone clear of every plan tone', () => {
    const plans = IDENTITY_TONES.filter((tone) => tone !== '--role-admin');
    for (const plan of plans) {
      expect(palette['--role-admin']).not.toBe(palette[plan]);
      expect(hueSeparation(palette['--role-admin'], palette[plan])).toBeGreaterThanOrEqual(60);
    }
  });

  /**
   * Administrator is an authority, not a fault.
   *
   * The ADMIN badge is red on purpose — it marks an account that can act on the
   * whole product — but it must not be read as an error or a destructive
   * action. The same 25° rule the session tones are held to applies: measurably
   * off the error red, rather than the error red at another brightness.
   */
  it('keeps the admin tone off the error-red axis', () => {
    expect(palette['--role-admin']).not.toBe(palette['--negative']);
    expect(hueSeparation(palette['--role-admin'], palette['--negative'])).toBeGreaterThanOrEqual(25);
    // Still unmistakably in the red family: crimson through to rose.
    const hue = hueOf(palette['--role-admin']);
    expect(hue).toBeGreaterThanOrEqual(300);
    expect(hue).toBeLessThanOrEqual(345);
  });

  /**
   * The badge's three surfaces exist in both appearances and all derive from the
   * one tone above, so border, fill and text cannot drift into three reds.
   */
  it('defines the admin badge surfaces from the single admin tone', () => {
    const css = readFileSync(resolve(`src/themes/portkheaw/${appearance}.css`), 'utf8');
    for (const token of ['--role-admin-bg', '--role-admin-border', '--role-admin-text']) {
      expect(css, `${appearance} ${token}`).toMatch(
        new RegExp(`${token}:\\s*(var\\(--role-admin\\)|color-mix\\([^;]*var\\(--role-admin\\)[^;]*\\));`),
      );
    }
  });

  /**
   * A holiday is not a fault, so the closure tone must not read as an error. It is
   * required to be a warm ORANGE — measurably off the red axis — rather than the
   * error red at a different brightness.
   */
  it('keeps the calendar-closure tone a warm orange, not an error red', () => {
    expect(palette['--session-event']).not.toBe(palette['--negative']);
    expect(hueSeparation(palette['--session-event'], palette['--negative'])).toBeGreaterThanOrEqual(25);
    // Orange, not yellow and not red: 15°–50° on the wheel.
    const hue = hueOf(palette['--session-event']);
    expect(hue).toBeGreaterThanOrEqual(15);
    expect(hue).toBeLessThanOrEqual(50);
  });
});
