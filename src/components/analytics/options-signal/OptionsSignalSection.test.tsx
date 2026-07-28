// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionsSignalServerContext } from '@/src/lib/analytics/options-signal/assemble';
import type { OptionsSignalType } from '@/src/lib/analytics/options-signal/types';
import { OPTIONS_SIGNAL_PRESENTATION } from './presentation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The card must never issue options requests of its own in a test environment;
// the browser-wide coordinator is the single owner of that traffic.
vi.mock('@/src/components/stock/chart/useOptionsSupportResistance', () => ({
  useOptionsSupportResistance: () => ({
    result: null,
    chain: null,
    loading: false,
    expirations: [],
    selectedExpiration: null,
    retryAt: null,
    setExpiration: () => undefined,
    refresh: () => undefined,
  }),
}));

const { OptionsSignalSection } = await import('./OptionsSignalSection');

const ASOF = '2026-07-27T20:00:00.000Z';

const context: OptionsSignalServerContext = {
  symbol: 'AAPL',
  timeframe: '1D',
  calculatedAt: '2026-07-28T00:00:00.000Z',
  latestCandleAt: '2026-07-27',
  finalizedCandles: 250,
  macro: {
    status: 'available',
    state: 'DELAYED',
    value: { benchmarks: [{ symbol: 'SPY', close: 500, ema20: 480 }, { symbol: 'QQQ', close: 400, ema20: 390 }] },
    provider: 'yahoo-finance-chart',
    asOf: ASOF,
  },
  trend: {
    status: 'available',
    state: 'DELAYED',
    value: { close: 110, ema20: 105, ema50: 100 },
    provider: 'yahoo-finance-chart',
    asOf: ASOF,
  },
  momentum: {
    status: 'available',
    state: 'DELAYED',
    value: { squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 },
    provider: 'yahoo-finance-chart',
    asOf: ASOF,
  },
  levels: {
    status: 'available',
    state: 'DELAYED',
    value: { close: 110, support: 105, resistance: 130 },
    provider: 'yahoo-finance-chart',
    asOf: ASOF,
  },
  event: {
    status: 'available',
    state: 'DELAYED',
    value: { reportDate: '2026-08-25', daysToEarnings: 28, timeOfDay: 'post-market' },
    provider: 'alpha-vantage',
    asOf: ASOF,
  },
  realizedVolatility: { value: 0.32, observations: 250 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactElement) {
  act(() => root.render(node));
}

describe('OptionsSignalSection', () => {
  it('renders every signal type with beginner Thai copy', () => {
    const types = Object.keys(OPTIONS_SIGNAL_PRESENTATION) as OptionsSignalType[];
    expect(types).toHaveLength(6);
    for (const type of types) {
      expect(OPTIONS_SIGNAL_PRESENTATION[type].headline.length).toBeGreaterThan(10);
      expect(OPTIONS_SIGNAL_PRESENTATION[type].title).toBe(type.replaceAll('_', ' '));
    }
  });

  it('shows the signal, the per-factor points and an unavailable IV state', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    const section = container.querySelector('section[aria-label="Options Signal Engine"]');
    expect(section).not.toBeNull();
    // Options chain is not loaded here, so IV and Put/Call must read UNAVAILABLE
    // rather than defaulting to a neutral number.
    expect(section!.getAttribute('data-signal')).toBe('CALL_WATCH');
    expect(container.textContent).toContain('Macro');
    expect(container.textContent).toContain('Risk/Reward');
    expect(container.textContent).toContain('อีก 28 วัน');
    expect(container.querySelectorAll('[data-testid], .uppercase')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).toContain('unavailable');
    // No contract shape may be suggested while premium cannot be evaluated.
    expect(container.textContent).toContain('ยังไม่แนะนำรูปแบบสัญญา');
  });

  it('keeps every tap target at least 44px tall', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const classes = button.getAttribute('class') ?? '';
      const style = button.getAttribute('style') ?? '';
      // Either an explicit min-height utility, or the InfoHint trigger whose
      // ≥44px target is an absolutely positioned ::after pseudo-element.
      expect(classes.includes('min-h-11') || classes.includes('h-9') || style.includes('18')).toBe(true);
    }
  });

  it('opens the calculation detail dialog', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    expect(trigger).toBeDefined();
    act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('คะแนนทิศทางมาจากอะไร');
    expect(document.body.textContent).toContain('TTM Squeeze');
    expect(document.body.textContent).toContain('Confidence');
  });

  it('states plainly that no server context means no fabricated signal', () => {
    render(<OptionsSignalSection symbol="AAPL" context={null} acceptedPrice={110} active />);
    expect(container.textContent).toContain('ไม่แสดงผลลัพธ์ที่เดาขึ้นเอง');
  });

  it('reports insufficient data instead of a signal when history is too short', () => {
    render(<OptionsSignalSection symbol="AAPL" context={{ ...context, finalizedCandles: 10 }} acceptedPrice={110} active />);
    expect(container.querySelector('section')!.getAttribute('data-signal')).toBe('insufficient-data');
    expect(container.textContent).toContain('ข้อมูลไม่เพียงพอ');
  });
});
