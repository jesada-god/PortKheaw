// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeControls } from './ThemeControls';

/**
 * The display section's UI contract.
 *
 * The theme picker moved from a row of cards into one settings row plus the
 * shared dialog, and nothing about *what* it may choose moved with it. So these
 * cases are about the surface only: the row says which theme is on, the sheet
 * opens and closes, a selectable theme selects, and a locked one asks for the
 * upgrade instead of changing anything. The gate itself is proved against the
 * entitlement resolver in premium-theme-gate.test.tsx and is not re-derived.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const setTheme = vi.fn();
const setAppearance = vi.fn();
const requestUpgrade = vi.fn();

let themeState = {
  theme: 'portkheaw' as string,
  appearance: 'system' as string,
  resolvedAppearance: 'dark' as string,
  premiumThemesAllowed: false,
};

vi.mock('./ThemeProvider', () => ({
  useTheme: () => ({ ...themeState, setTheme, setAppearance }),
}));

vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  useEntitlement: () => ({ requestUpgrade }),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ThemeControls />); });
}

const query = <T extends HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);
const row = () => query<HTMLButtonElement>('[data-testid="theme-row"]')!;
const option = (id: string) => query<HTMLButtonElement>(`[data-testid="theme-option-${id}"]`);
const dialog = () => query('[role="dialog"]');
const click = async (node: HTMLElement) => {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  themeState = {
    theme: 'portkheaw',
    appearance: 'system',
    resolvedAppearance: 'dark',
    premiumThemesAllowed: false,
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe('the display section at rest', () => {
  it('shows one row with the current theme, a preview and no option list', async () => {
    themeState.theme = 'dokturek';
    themeState.premiumThemesAllowed = true;
    await render();

    expect(row().textContent).toContain('ธีมสี');
    expect(row().textContent).toContain('Dokturek Violet');
    expect(row().getAttribute('aria-haspopup')).toBe('dialog');
    expect(row().getAttribute('aria-expanded')).toBe('false');
    // The colours come from the theme's own palette file, never from here.
    expect(row().querySelector('[data-theme-swatch="dokturek"]')).not.toBeNull();

    // Nothing premium is rendered until the reader asks for the picker.
    expect(dialog()).toBeNull();
    expect(option('portkheaw')).toBeNull();
    expect(option('bitswap')).toBeNull();
  });

  it('keeps the appearance control exactly as it was, beside the row', async () => {
    await render();
    const modes = [...document.body.querySelectorAll('fieldset button')];
    expect(modes.map((node) => node.textContent)).toEqual([
      expect.stringContaining('ตามระบบ'),
      expect.stringContaining('สว่าง'),
      expect.stringContaining('มืด'),
    ]);

    await click(modes[1] as HTMLElement);
    expect(setAppearance).toHaveBeenCalledWith('light');
    // Choosing an appearance is not a theme change.
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('never submits the settings form it sits inside', async () => {
    await render();
    expect(row().type).toBe('button');
  });
});

describe('the picker sheet', () => {
  it('opens on the row as a modal dialog and lists all three themes', async () => {
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    expect(row().getAttribute('aria-expanded')).toBe('true');
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    for (const id of ['portkheaw', 'bitswap', 'dokturek']) {
      expect(option(id), id).not.toBeNull();
      expect(option(id)!.type).toBe('button');
    }
  });

  it('marks the current theme as selected and the others as not', async () => {
    themeState.theme = 'bitswap';
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    expect(option('bitswap')!.getAttribute('aria-pressed')).toBe('true');
    expect(option('portkheaw')!.getAttribute('aria-pressed')).toBe('false');
    expect(option('dokturek')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('selects an available theme and closes', async () => {
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());
    await click(option('bitswap')!);

    expect(setTheme).toHaveBeenCalledWith('bitswap');
    expect(requestUpgrade).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(row().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape without choosing anything', async () => {
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe('how a row reads', () => {
  /*
   * A theme is chosen by pressing the whole row, so nothing in front of the
   * label may look like a per-row on/off control. One colour dot, and the plan
   * badge only where a plan is actually being asked for.
   */
  it('previews each theme with one bare dot — no track, knob or wrapper', async () => {
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    for (const id of ['portkheaw', 'bitswap', 'dokturek']) {
      const swatches = option(id)!.querySelectorAll('[data-theme-swatch]');
      expect(swatches.length, id).toBe(1);
      // The dot is the whole thing: a child would be a knob inside a track.
      expect(swatches[0]!.children.length, id).toBe(0);
      expect(swatches[0]!.className, id).toContain('rounded-full');
    }
  });

  it('badges the paid themes with the plan and leaves the free one unbadged', async () => {
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    expect(option('portkheaw')!.textContent).not.toContain('PRO');
    for (const id of ['bitswap', 'dokturek']) {
      expect(option(id)!.textContent, id).toContain('PRO+');
      // Entitled: the badge names the plan without claiming the row is shut.
      expect(option(id)!.querySelector('.lucide-lock'), id).toBeNull();
    }
  });

  it('keeps the checkmark as the only mark of the chosen theme', async () => {
    themeState.theme = 'bitswap';
    themeState.premiumThemesAllowed = true;
    await render();
    await click(row());

    expect(option('bitswap')!.querySelector('.lucide-check')).not.toBeNull();
    expect(option('portkheaw')!.querySelector('.lucide-check')).toBeNull();
    expect(option('dokturek')!.querySelector('.lucide-check')).toBeNull();
  });
});

describe('a reader without the paid plan', () => {
  it('shows the paid themes as locked, badged with the plan they need', async () => {
    await render();
    await click(row());

    expect(option('portkheaw')!.dataset.locked).toBeUndefined();
    expect(option('portkheaw')!.querySelector('.lucide-lock')).toBeNull();
    for (const id of ['bitswap', 'dokturek']) {
      expect(option(id)!.querySelector('.lucide-lock'), id).not.toBeNull();
      expect(option(id)!.textContent, id).toContain('PRO+');
      // Locked is a state to escape, not the current choice.
      expect(option(id)!.querySelector('.lucide-check'), id).toBeNull();
    }
  });

  it('shows the paid themes locked, with the plan they need', async () => {
    await render();
    await click(row());

    expect(option('portkheaw')!.dataset.locked).toBeUndefined();
    for (const id of ['bitswap', 'dokturek']) {
      expect(option(id)!.dataset.locked, id).toBe('true');
      // Locked is a state, not a pressed toggle, and the plan is in the name.
      expect(option(id)!.getAttribute('aria-pressed')).toBeNull();
      expect(option(id)!.getAttribute('aria-label')).toContain('Pro');
    }
    expect(document.body.textContent).toContain('ธีมสีพิเศษใช้ได้ในแพ็กเกจ Pro ขึ้นไป');
  });

  it('asks for the upgrade instead of changing the theme, and leaves one dialog open', async () => {
    await render();
    await click(row());
    await click(option('bitswap')!);

    expect(setTheme).not.toHaveBeenCalled();
    expect(requestUpgrade).toHaveBeenCalledWith({
      capability: 'theme.premium',
      source: 'settings.theme',
    });
    // The sheet steps aside so the shared upgrade prompt is the only dialog.
    expect(dialog()).toBeNull();
  });

  it('still lets them pick the free theme', async () => {
    themeState.theme = 'bitswap';
    await render();
    await click(row());
    await click(option('portkheaw')!);

    expect(setTheme).toHaveBeenCalledWith('portkheaw');
    expect(requestUpgrade).not.toHaveBeenCalled();
  });
});
