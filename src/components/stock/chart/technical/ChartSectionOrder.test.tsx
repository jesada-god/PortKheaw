// @vitest-environment jsdom

import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeOptionsSupportResistance } from '@/src/lib/analytics/options-sr';
import { DEFAULT_CHART_PREFERENCES } from '@/src/lib/analytics/timeframe';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { CanonicalBarInput } from '@/src/lib/analytics/canonical-bars';
import { resolvePriceAdjustment } from '@/src/lib/analytics/price-adjustment';

const calls = vi.hoisted(() => ({ expirations: 0, chain: 0, levels: 0 }));

// The chart canvas is irrelevant to page order; stub it so the test stays a
// pure DOM-order assertion instead of a lightweight-charts integration.
vi.mock('./TechnicalChartHost', () => ({
  TechnicalChartHost: () => React.createElement('div', { 'data-testid': 'technical-chart-host' }),
}));

vi.mock('./levels-client', () => ({
  levelsRequestKey: (symbol: string, interval: string) => `chart-levels:${symbol}:${interval}`,
  requestChartLevels: vi.fn(async () => {
    calls.levels += 1;
    return {
      symbol: 'AAPL', basisInterval: '1D' as const, sourceTime: Date.UTC(2026, 6, 24) / 1_000, provider: 'yahoo',
      pivot: 206.87, resistance: [210.9, 214.95, 218] as [number, number, number],
      support: [203.8, 200.75, 196.7] as [number, number, number],
    };
  }),
}));

const EXPIRATION = '2026-08-21';
const AS_OF = '2026-07-27T00:00:00.000Z';
const STRIKES = [190, 195, 200, 205, 210, 215, 220, 225, 230];

function contract(type: 'call' | 'put', strike: number, openInterest: number): OptionContract {
  return {
    contractSymbol: `${type}-${strike}`, underlyingSymbol: 'AAPL', type, expiration: EXPIRATION, strike,
    bid: null, ask: null, last: null, mark: null, volume: null, openInterest,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpaca',
    marketDataProvider: null, marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: null,
    asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
  };
}

const chain: OptionsChain = {
  underlyingSymbol: 'AAPL', spot: 206.87, expiration: EXPIRATION, expirations: [EXPIRATION],
  calls: STRIKES.map((strike, index) => contract('call', strike, 200 + index * 130)),
  puts: STRIKES.map((strike, index) => contract('put', strike, 1_500 - index * 140)),
  provider: 'alpaca', asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
  delayedMinutes: null, completeness: 1, warnings: [],
};

vi.mock('@/src/lib/stock-detail/options-source', () => ({
  optionsExpirationsCoordinator: {
    load: vi.fn(async () => {
      calls.expirations += 1;
      return { ok: true, expirations: [EXPIRATION, '2026-09-18'], provider: 'alpaca', classification: null, message: null, retryAfterSeconds: null };
    }),
    reset: vi.fn(() => true),
  },
  optionsChainCoordinator: {
    load: vi.fn(async () => {
      calls.chain += 1;
      return {
        ok: true,
        chain,
        result: computeOptionsSupportResistance({
          symbol: 'AAPL', expiration: EXPIRATION, acceptedPrice: 206.87,
          calls: chain.calls, puts: chain.puts, provider: 'alpaca', asOf: AS_OF, status: 'delayed',
        }, { nowMs: Date.parse(AS_OF) }),
        provider: 'alpaca', classification: null, retryAfterSeconds: null,
      };
    }),
    cooldownRemainingMs: vi.fn(() => 0),
    reset: vi.fn(() => true),
  },
}));

import { TechnicalAnalysisChart } from './TechnicalAnalysisChart';

const DAY = 86_400;
const START = Date.UTC(2026, 0, 5) / 1_000;
const prices: CanonicalBarInput[] = Array.from({ length: 60 }, (_, index) => ({
  time: START + index * DAY,
  open: 200 + index * 0.1, high: 203 + index * 0.1, low: 198 + index * 0.1, close: 201 + index * 0.1,
  volume: 1_000 + index,
}));

function props(overrides: Partial<React.ComponentProps<typeof TechnicalAnalysisChart>> = {}) {
  return {
    symbol: 'AAPL',
    interval: '1D' as const,
    range: '1y' as const,
    prices,
    datasetKey: 'AAPL:1D:1y',
    currentPrice: 206.87,
    priceProvenance: 'yahoo · delayed',
    priceAdjustment: resolvePriceAdjustment({ interval: '1D', requested: true, providerAdjusted: true, source: 'yahoo' }),
    currency: '$',
    preferences: { ...DEFAULT_CHART_PREFERENCES, options: true },
    onSelectInterval: () => undefined,
    onSelectRange: () => undefined,
    onToggleFavoriteInterval: () => undefined,
    onToggleFavoriteRange: () => undefined,
    onChartType: () => undefined,
    onToggle: () => undefined,
    ...overrides,
  };
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, root: createRoot(host) };
}

/** Ascending document order of the given test ids inside a container. */
function order(host: HTMLElement, ids: readonly string[]): string[] {
  const nodes = [...host.querySelectorAll<HTMLElement>('[data-testid]')];
  return nodes.map((node) => node.dataset.testid!).filter((id) => ids.includes(id));
}

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.expirations = 0; calls.chain = 0; calls.levels = 0;
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Stock Detail → Chart section order', () => {
  it('renders toolbar → chart → Options → แนวรับ–แนวต้าน in one DOM order for every viewport', async () => {
    const { host, root } = mount();
    await act(async () => root.render(<TechnicalAnalysisChart {...props()} />));
    await act(async () => { await Promise.resolve(); });

    expect(order(host, ['chart-toolbar', 'technical-chart-host', 'options-levels', 'support-resistance-panel']))
      .toEqual(['chart-toolbar', 'technical-chart-host', 'options-levels', 'support-resistance-panel']);

    const chartHost = host.querySelector('[data-testid="technical-chart-host"]')!;
    const options = host.querySelector('[data-testid="options-levels"]')!;
    const sr = host.querySelector('[data-testid="support-resistance-panel"]')!;
    // Options follows the chart, S/R follows Options — never the other way round.
    expect(chartHost.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(options.compareDocumentPosition(sr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing reorders visually per breakpoint, so mobile and desktop agree.
    const section = host.querySelector('[data-testid="technical-analysis-chart"]')!;
    expect(section.innerHTML).not.toMatch(/(?:sm|md|lg|xl):(?:order-|flex-col-reverse|flex-row-reverse)/);
    await act(async () => root.unmount());
  });

  it('loads the real chain with at most one expirations and one chain request', async () => {
    const { host, root } = mount();
    await act(async () => root.render(<StrictMode><TechnicalAnalysisChart {...props()} /></StrictMode>));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(calls.expirations).toBe(1);
    expect(calls.chain).toBe(1);
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('โหลดข้อมูลสำเร็จ');
    expect(host.querySelector('[data-testid="options-card-call-wall"]')?.textContent).toMatch(/\$\d+\.\d{2}/);
    expect(host.querySelector('[data-testid="options-card-put-wall"]')?.textContent).toMatch(/\$\d+\.\d{2}/);
    expect(host.querySelector('[data-testid="options-card-max-pain"]')?.textContent).toMatch(/\$\d+\.\d{2}/);

    // A pure presentation re-render must not touch the network again.
    const before = { ...calls };
    await act(async () => root.render(<StrictMode><TechnicalAnalysisChart {...props({ preferences: { ...DEFAULT_CHART_PREFERENCES, options: true, rsi: true } })} /></StrictMode>));
    await act(async () => { await Promise.resolve(); });
    expect(calls.expirations).toBe(before.expirations);
    expect(calls.chain).toBe(before.chain);
    await act(async () => root.unmount());
  });

  it('keeps the Options slot but issues zero provider requests while it is collapsed', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <TechnicalAnalysisChart {...props({ preferences: { ...DEFAULT_CHART_PREFERENCES, options: false } })} />,
    ));
    await act(async () => { await Promise.resolve(); });

    expect(order(host, ['technical-chart-host', 'options-levels', 'support-resistance-panel']))
      .toEqual(['technical-chart-host', 'options-levels', 'support-resistance-panel']);
    expect(calls.expirations).toBe(0);
    expect(calls.chain).toBe(0);
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('ยังไม่ได้โหลดข้อมูล');
    await act(async () => root.unmount());
  });

  it('keeps the S/R methodology unchanged: pivot levels, real touch statistics and no time estimate', async () => {
    const { host, root } = mount();
    await act(async () => root.render(<TechnicalAnalysisChart {...props()} />));
    await act(async () => { await Promise.resolve(); });

    const sr = host.querySelector('[data-testid="support-resistance-panel"]')!;
    for (const id of ['R1', 'R2', 'R3', 'S1', 'S2', 'S3']) {
      expect(sr.querySelector(`[data-testid="sr-level-${id}"]`), id).not.toBeNull();
    }
    expect(sr.querySelector('[data-testid="sr-level-R1"]')?.textContent).toContain('$210.90');
    expect(sr.querySelector('[data-testid="sr-level-S1"]')?.textContent).toContain('$203.80');
    expect(sr.querySelector('[data-testid="sr-current-price"]')?.textContent).toContain('$206.87');
    expect(sr.querySelector('[data-testid="sr-level-S1-summary"]')?.textContent).toMatch(/^(ชน \d+ · รับอยู่|ยังไม่มีประวัติทดสอบระดับนี้)/);
    expect(sr.textContent).not.toMatch(/ETA|คาดว่าจะถึง|ภายใน \d+ วัน/);
    await act(async () => root.unmount());
  });
});
