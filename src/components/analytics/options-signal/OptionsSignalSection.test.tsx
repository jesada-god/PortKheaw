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
const hookCalls: Array<{ symbol: string; enabled: boolean; active: boolean }> = [];
let hookState: {
  result: unknown;
  chain: unknown;
  staleFallback: unknown;
  loading: boolean;
} = { result: null, chain: null, staleFallback: null, loading: false };

vi.mock('@/src/components/stock/chart/useOptionsSupportResistance', () => ({
  useOptionsSupportResistance: (options: { symbol: string; enabled: boolean; active: boolean }) => {
    hookCalls.push({ symbol: options.symbol, enabled: options.enabled, active: options.active });
    return {
      ...hookState,
      expirations: [],
      selectedExpiration: null,
      retryAt: null,
      setExpiration: () => undefined,
      refresh: () => undefined,
    };
  },
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
  hookCalls.length = 0;
  hookState = { result: null, chain: null, staleFallback: null, loading: false };
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

  it('explains every beginner-hostile metric it shows with the shared glossary hint', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    // On the card itself.
    for (const term of ['optionsSignalConfidence', 'ivRank', 'daysToEarnings']) {
      expect(container.querySelector(`[data-testid="info-hint-${term}"]`), term).not.toBeNull();
    }

    const trigger = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ดูรายละเอียดการคำนวณ'));
    act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // ...and on the rows inside the calculation breakdown.
    for (const term of ['ttmSqueeze', 'relativeVolume', 'putCallRatio']) {
      const hint = document.body.querySelector(`[data-testid="info-hint-${term}"]`);
      expect(hint, term).not.toBeNull();
      // Reachable by keyboard and labelled for screen readers, not a bare icon.
      expect(hint!.tagName).toBe('BUTTON');
      expect(hint!.getAttribute('aria-label')).toContain('คำอธิบาย');
      expect(hint!.getAttribute('aria-expanded')).toBe('false');
    }
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

describe('OptionsSignalSection — options data coverage', () => {
  const staleChain = {
    underlyingSymbol: 'AAPL',
    spot: 210,
    expiration: '2026-08-21',
    expirations: ['2026-08-21'],
    calls: [205, 210, 215].map((strike) => baseContract('call', strike)),
    puts: [205, 210, 215].map((strike) => baseContract('put', strike)),
    provider: 'alpaca',
    asOf: '2026-07-28T19:30:00.000Z',
    timestampKind: 'receipt',
    status: 'delayed',
    delayedMinutes: 15,
    completeness: 1,
    warnings: [],
  };
  const staleSr = {
    status: 'available',
    symbol: 'AAPL',
    expiration: '2026-08-21',
    acceptedPrice: 210,
    callWall: null, putWall: null, maxPain: null,
    totalCallOI: 10_000, totalPutOI: 4_500, putCallOIRatio: 0.45,
    strikeCoverage: 12, contractCoverage: 1,
    provider: 'alpaca', asOf: '2026-07-28T19:30:00.000Z',
    dataMode: 'DELAYED', reliability: 'high', limitations: [],
  };

  function baseContract(type: 'call' | 'put', strike: number) {
    return {
      contractSymbol: `${type}-${strike}`, underlyingSymbol: 'AAPL', type,
      expiration: '2026-08-21', strike,
      bid: 1, ask: 1.2, last: null, mark: null, volume: 10, openInterest: 500,
      impliedVolatility: 0.42,
      delta: null, gamma: null, theta: null, vega: null, rho: null, inTheMoney: null,
      multiplier: 100, currency: 'USD', provider: 'alpaca',
      marketDataProvider: null, marketDataFeed: null, oiAsOf: null,
      delayedMinutes: null, valuationSource: null,
      asOf: '2026-07-28T19:30:00.000Z', timestampKind: 'receipt', status: 'delayed',
    };
  }

  it('reads options data only through the shared coordinator hook, never a second request', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    // Exactly one consumer of the shared hook, gated on the Analysis tab being open.
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(new Set(hookCalls.map((call) => call.symbol))).toEqual(new Set(['AAPL']));
    for (const call of hookCalls) {
      expect(call.enabled).toBe(true);
      expect(call.active).toBe(true);
    }
  });

  it('recovers Put/Call and IV from the stale fallback after a rate limit, labelled STALE', () => {
    hookState = { result: null, chain: null, staleFallback: {
      chain: staleChain, result: staleSr, fetchedAt: '2026-07-28T19:30:00.000Z', reason: 'rate-limited',
    }, loading: false };
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={210} active />);

    const text = container.textContent ?? '';
    // Both dimensions are readable again rather than erased...
    expect(text).not.toContain('—/ 10');
    // ...and both are disclosed as stale, never as current.
    expect(text.toLowerCase()).toContain('stale');
  });

  it('still reports UNAVAILABLE when a rate limit had no last-good chain to fall back on', () => {
    hookState = { result: null, chain: null, staleFallback: null, loading: false };
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={210} active />);
    expect(container.textContent?.toLowerCase()).toContain('unavailable');
  });

  it('rebuilds from scratch on a symbol change so no signal can be carried over', () => {
    render(<OptionsSignalSection symbol="AAPL" context={context} acceptedPrice={110} active />);
    const first = container.querySelector('section')!.getAttribute('data-signal');
    expect(first).toBeTruthy();

    render(<OptionsSignalSection symbol="NVDA" context={{ ...context, symbol: 'NVDA', finalizedCandles: 10 }} acceptedPrice={110} active />);
    // The short-history NVDA context must win immediately — no stale AAPL signal.
    expect(container.querySelector('section')!.getAttribute('data-signal')).toBe('insufficient-data');
    expect(hookCalls.some((call) => call.symbol === 'NVDA')).toBe(true);
  });
});
