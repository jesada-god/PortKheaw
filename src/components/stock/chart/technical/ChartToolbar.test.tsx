// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartToolbar } from './ChartToolbar';
import { DEFAULT_CHART_PREFERENCES, type ChartPreferences } from '@/src/lib/analytics/timeframe';
import { CHART_TYPE_OPTIONS } from '@/src/lib/analytics/chart-types/catalog';

let activeRoot: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(async () => {
  if (activeRoot) {
    const root = activeRoot;
    activeRoot = null;
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(preferences: Partial<ChartPreferences> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  activeRoot = root;
  const onChartType = vi.fn();
  await act(async () => root.render(
    <ChartToolbar
      interval="1D"
      range="1y"
      preferences={{ ...DEFAULT_CHART_PREFERENCES, ...preferences }}
      optionsAvailable
      onSelectInterval={vi.fn()}
      onSelectRange={vi.fn()}
      onToggleFavoriteInterval={vi.fn()}
      onToggleFavoriteRange={vi.fn()}
      onChartType={onChartType}
      onToggle={vi.fn()}
      onResetView={vi.fn()}
    />,
  ));
  return { root, onChartType };
}

const trigger = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
const menu = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}-menu"]`);

describe('ChartToolbar menus stay inside the viewport', () => {
  it('portals the menu to the body so the chart card cannot clip it', async () => {
    await render();
    await act(async () => { trigger('chart-type-trigger').click(); });
    const panel = menu('chart-type-trigger')!;
    expect(panel).not.toBeNull();
    // Rendered at the document root, not inside the overflow-hidden chart card.
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe('fixed');
  });

  it('resolves a placement that can never widen the page', async () => {
    await render();
    await act(async () => { trigger('indicators-trigger').click(); });
    const panel = menu('indicators-trigger')!;
    const left = Number.parseFloat(panel.style.left);
    const width = Number.parseFloat(panel.style.width);
    const top = Number.parseFloat(panel.style.top);
    const maxHeight = Number.parseFloat(panel.style.maxHeight);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(window.innerWidth);
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight);
    // Long lists scroll inside the panel rather than pushing the layout.
    expect(panel.className).toContain('overflow-y-auto');
    expect(panel.className).toContain('overscroll-contain');
  });

  it('closes on Escape and on a pointer press outside', async () => {
    await render();
    await act(async () => { trigger('chart-type-trigger').click(); });
    expect(menu('chart-type-trigger')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu('chart-type-trigger')).toBeNull();

    await act(async () => { trigger('chart-type-trigger').click(); });
    await act(async () => {
      // jsdom has no PointerEvent constructor; the listener only reads `target`.
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(menu('chart-type-trigger')).toBeNull();
  });
});

describe('ChartToolbar chart types', () => {
  it('offers every catalogued chart type as a radio, with the active one checked', async () => {
    await render({ chartType: 'line' });
    await act(async () => { trigger('chart-type-trigger').click(); });
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(rows).toHaveLength(CHART_TYPE_OPTIONS.length);
    // The leading marker is decorative; the label is the accessible text.
    expect(rows.map((row) => row.textContent?.replace('●', ''))).toEqual(CHART_TYPE_OPTIONS.map((option) => option.label));
    const checked = rows.filter((row) => row.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].dataset.testid).toBe('chart-type-line');
    // The trigger names the active type.
    expect(trigger('chart-type-trigger').textContent).toContain('Line');
  });

  it('selects a chart type without issuing a market request', async () => {
    const { onChartType } = await render();
    await act(async () => { trigger('chart-type-trigger').click(); });
    for (const option of CHART_TYPE_OPTIONS) {
      await act(async () => { trigger(`chart-type-${option.id}`).click(); });
    }
    expect(onChartType.mock.calls.map((call) => call[0])).toEqual(CHART_TYPE_OPTIONS.map((option) => option.id));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps every menu row at a ≥44px touch target', async () => {
    await render();
    await act(async () => { trigger('chart-type-trigger').click(); });
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    rows.forEach((row) => expect(row.className).toContain('min-h-11'));
  });
});
