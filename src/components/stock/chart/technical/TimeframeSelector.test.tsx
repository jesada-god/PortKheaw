// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeframeSelector } from './TimeframeSelector';
import { DEFAULT_CHART_PREFERENCES } from '@/src/lib/analytics/timeframe';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';

let matches = true;

function stubMatchMedia(desktop: boolean) {
  matches = desktop;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width') ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;
let activeRoot: Root | null = null;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  stubMatchMedia(true);
});

afterEach(async () => {
  // Unmount before clearing the DOM so a failed assertion cannot leave a live
  // portal behind for the next test to trip over.
  if (activeRoot) {
    const root = activeRoot;
    activeRoot = null;
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

interface Handlers {
  onSelectInterval: ReturnType<typeof vi.fn>;
  onSelectRange: ReturnType<typeof vi.fn>;
  onToggleFavoriteInterval: ReturnType<typeof vi.fn>;
  onToggleFavoriteRange: ReturnType<typeof vi.fn>;
}

async function render(options: {
  interval?: CandleInterval;
  range?: CandleRange;
  favoriteIntervals?: CandleInterval[];
  favoriteRanges?: CandleRange[];
} = {}): Promise<{ root: Root; host: HTMLDivElement; handlers: Handlers }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  activeRoot = root;
  const handlers: Handlers = {
    onSelectInterval: vi.fn(),
    onSelectRange: vi.fn(),
    onToggleFavoriteInterval: vi.fn(),
    onToggleFavoriteRange: vi.fn(),
  };
  await act(async () => root.render(
    <TimeframeSelector
      interval={options.interval ?? '1D'}
      range={options.range ?? '1y'}
      favoriteIntervals={options.favoriteIntervals ?? DEFAULT_CHART_PREFERENCES.favoriteIntervals}
      favoriteRanges={options.favoriteRanges ?? DEFAULT_CHART_PREFERENCES.favoriteRanges}
      {...handlers}
    />,
  ));
  return { root, host, handlers };
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="timeframe-trigger"]')!;
const panel = () => document.querySelector('[data-testid="timeframe-popover"]') ?? document.querySelector('[data-testid="timeframe-sheet"]');
const optionByLabel = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-timeframe-option]'))
  .find((button) => button.getAttribute('aria-label') === label
    || button.getAttribute('aria-label') === `${label} เลือกอยู่`);

async function open() {
  await act(async () => { trigger().click(); });
}

describe('TimeframeSelector — desktop popover', () => {
  it('opens and closes an anchored popover and reports its state through ARIA', async () => {
    const { root } = await render();
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();

    await open();
    expect(document.querySelector('[data-testid="timeframe-popover"]')).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    await act(async () => { trigger().click(); });
    expect(panel()).toBeNull();
  });

  it('separates the candle-interval groups from the data-range section', async () => {
    const { root } = await render();
    await open();
    const listboxes = Array.from(document.querySelectorAll('[role="listbox"]')).map((node) => node.getAttribute('aria-label'));
    expect(listboxes).toContain('แท่งเทียน นาที');
    expect(listboxes).toContain('แท่งเทียน ชั่วโมง');
    expect(listboxes).toContain('แท่งเทียน วัน');
    expect(listboxes).toContain('ช่วงข้อมูล');
  });

  it('shows "12 เดือน" in the data-range section and never as a candle interval', async () => {
    const { root } = await render();
    await open();
    const rangeSection = Array.from(document.querySelectorAll('[role="listbox"]'))
      .find((node) => node.getAttribute('aria-label') === 'ช่วงข้อมูล')!;
    expect(rangeSection.textContent).toContain('12 เดือน');
    const intervalSections = Array.from(document.querySelectorAll('[role="listbox"]'))
      .filter((node) => node.getAttribute('aria-label')?.startsWith('แท่งเทียน'));
    intervalSections.forEach((section) => expect(section.textContent).not.toContain('12 เดือน'));
  });

  it('marks the active interval and range as selected for screen readers', async () => {
    const { root } = await render({ interval: '1D', range: '1y' });
    await open();
    expect(optionByLabel('1 วัน')?.getAttribute('aria-selected')).toBe('true');
    expect(optionByLabel('12 เดือน')?.getAttribute('aria-selected')).toBe('true');
    expect(optionByLabel('12 เดือน')?.getAttribute('aria-label')).toBe('12 เดือน เลือกอยู่');
    expect(optionByLabel('5 นาที')?.getAttribute('aria-selected')).toBe('false');
  });

  it('emits the canonical 1y key when "12 เดือน" is chosen', async () => {
    const { root, handlers } = await render({ interval: '1D', range: '6m' });
    await open();
    await act(async () => { optionByLabel('12 เดือน')?.click(); });
    expect(handlers.onSelectRange).toHaveBeenCalledWith('1y');
    expect(handlers.onSelectInterval).not.toHaveBeenCalled();
  });

  it('does not re-select the value that is already active', async () => {
    const { root, handlers } = await render({ interval: '1D', range: '1y' });
    await open();
    await act(async () => { optionByLabel('12 เดือน')?.click(); });
    expect(handlers.onSelectRange).not.toHaveBeenCalled();

    await open();
    await act(async () => { optionByLabel('1 วัน')?.click(); });
    expect(handlers.onSelectInterval).not.toHaveBeenCalled();
  });

  it('disables an unsupported interval/range combination with a reason', async () => {
    const { root, handlers } = await render({ interval: '1m', range: '5d' });
    await open();
    const twelveMonths = optionByLabel('12 เดือน');
    expect(twelveMonths?.disabled).toBe(true);
    expect(twelveMonths?.getAttribute('title')).toContain('1 นาที');
    await act(async () => { twelveMonths?.click(); });
    expect(handlers.onSelectRange).not.toHaveBeenCalled();
  });

  it('never issues a market request from opening the popup or toggling a favourite', async () => {
    const { root, handlers } = await render();
    await open();
    const favourite = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.getAttribute('aria-label') === '12 เดือน เพิ่มเป็นรายการโปรด'
        || button.getAttribute('aria-label') === 'นำ 12 เดือน ออกจากรายการโปรด')!;
    await act(async () => { favourite.click(); });
    expect(handlers.onToggleFavoriteRange).toHaveBeenCalledWith('1y');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('labels the favourite affordance separately for intervals and ranges', async () => {
    const { root, handlers } = await render({ favoriteIntervals: [], favoriteRanges: [] });
    await open();
    const addFiveMinutes = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.getAttribute('aria-label') === '5 นาที เพิ่มเป็นรายการโปรด')!;
    await act(async () => { addFiveMinutes.click(); });
    expect(handlers.onToggleFavoriteInterval).toHaveBeenCalledWith('5m');
    expect(handlers.onToggleFavoriteRange).not.toHaveBeenCalled();
  });

  it('offers stored favourites as quick access without leaving the popup', async () => {
    const { root, handlers } = await render({ favoriteIntervals: ['1m', '5m'], favoriteRanges: ['1y'] });
    await open();
    const quick = document.querySelector('[aria-label="รายการโปรด"]')!;
    expect(quick.textContent).toContain('1m');
    expect(quick.textContent).toContain('5m');
    expect(quick.textContent).toContain('12M');
    const fiveMinutes = Array.from(quick.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '5m')!;
    await act(async () => { fiveMinutes.click(); });
    expect(handlers.onSelectInterval).toHaveBeenCalledWith('5m');
  });
});

describe('TimeframeSelector — keyboard and focus', () => {
  it('moves focus with the arrow keys between options', async () => {
    const { root } = await render();
    await open();
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-timeframe-option]:not([disabled])'));
    options[0].focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(options[1]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(options[0]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { root } = await render();
    await open();
    expect(panel()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('restores focus to the trigger after a selection', async () => {
    const { root } = await render({ range: '6m' });
    await open();
    await act(async () => { optionByLabel('12 เดือน')?.click(); });
    expect(document.activeElement).toBe(trigger());
  });
});

describe('TimeframeSelector — mobile bottom sheet', () => {
  beforeEach(() => stubMatchMedia(false));

  it('renders a full-width bottom sheet instead of the desktop popover', async () => {
    const { root } = await render();
    await open();
    const sheet = document.querySelector<HTMLElement>('[data-testid="timeframe-sheet"]');
    expect(sheet).not.toBeNull();
    expect(document.querySelector('[data-testid="timeframe-popover"]')).toBeNull();
    expect(sheet?.className).toContain('w-full');
    expect(sheet?.className).toContain('max-h-[min(80dvh,100%)]');
    expect(sheet?.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });

  it('offers 12 เดือน on the sheet and closes on the backdrop', async () => {
    const { root, handlers } = await render({ range: '3m' });
    await open();
    expect(document.querySelector('[data-testid="timeframe-sheet"]')?.textContent).toContain('12 เดือน');
    await act(async () => { optionByLabel('12 เดือน')?.click(); });
    expect(handlers.onSelectRange).toHaveBeenCalledWith('1y');

    await open();
    const backdrop = document.querySelector<HTMLElement>('[data-testid="timeframe-sheet-backdrop"]')!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="timeframe-sheet"]')).toBeNull();
  });

  it('keeps every option and favourite control at a ≥44px touch target', async () => {
    const { root } = await render();
    await open();
    const sheet = document.querySelector('[data-testid="timeframe-sheet"]')!;
    const options = Array.from(sheet.querySelectorAll<HTMLButtonElement>('[data-timeframe-option]'));
    expect(options.length).toBeGreaterThan(0);
    options.forEach((option) => expect(option.className).toContain('min-h-11'));
    const favourites = Array.from(sheet.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
    favourites.forEach((button) => expect(button.className).toMatch(/h-11/));
  });
});
