// @vitest-environment jsdom

/**
 * Arriving at the simulator from the options chain is the path a reader actually
 * takes, and it had two defects that only showed up once mounted.
 *
 * The import effect decided whether the contract had been applied by reading a
 * flag that the `setWorkspace` updater assigns. React applies that updater after
 * the calling line has already run, so the flag was still false on every single
 * successful import: the reader got "ข้อมูลสัญญาที่ได้รับกลับมาไม่ตรงกับที่เลือกไว้"
 * instead of the confirmation, was never moved to the inputs step, and never saw
 * the leg that had in fact been imported.
 *
 * The premium behind it came from a chain snapshot that is always `delayed` in
 * production, which the prefill refused outright — so the imported leg carried a
 * zero premium, the one input that collapses debit, risk, break-even and return.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/tools/monte-carlo',
}));
vi.mock('@/src/components/layout/Header', () => ({
  default: ({ title }: { title: string }) => <header>{title}</header>,
}));
vi.mock('@/src/lib/market-data/fx/client', () => ({
  fetchFxRate: () => Promise.resolve({ quote: null }),
}));

import SimulatorWorkspace from './SimulatorWorkspace';

const CONTRACT_SYMBOL = 'AAPL260918C00310000';

/** The exact shape production returns for AAPL: an Alpaca snapshot, always delayed. */
function chainPayload(overrides: Record<string, unknown> = {}) {
  return {
    underlyingSymbol: 'AAPL', spot: 309.38, expiration: '2026-09-18', expirations: ['2026-09-18'],
    provider: 'alpaca', asOf: '2026-08-05T19:09:50.316Z', timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: 15, completeness: 1, warnings: [],
    calls: [{
      contractSymbol: CONTRACT_SYMBOL, underlyingSymbol: 'AAPL', type: 'call', expiration: '2026-09-18',
      strike: 310, bid: 11.42, ask: 11.65, last: 11.38, mark: 11.535, volume: 3_582, openInterest: 17_238,
      inTheMoney: false, multiplier: 100, currency: 'USD', provider: 'alpaca',
      marketDataProvider: 'alpaca-options-data', marketDataFeed: 'indicative',
      asOf: '2026-08-05T19:09:49.387Z', oiAsOf: '2026-08-03', timestampKind: 'receipt', status: 'delayed',
      delayedMinutes: null, impliedVolatility: 0.2651,
      delta: 0.5239, gamma: 0.014, theta: -0.1437, vega: 0.4273, rho: 0.1813, valuationSource: 'provider',
      ...overrides,
    }],
    puts: [],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function stubChainFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/market/options/chain')) {
      return Promise.resolve(new Response(JSON.stringify({ data: payload, error: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response('{}', { status: 401 }));
  }));
}

async function mountAtChainLink(): Promise<void> {
  window.history.replaceState({}, '', `/tools/monte-carlo?symbol=AAPL&expiration=2026-09-18&contract=${CONTRACT_SYMBOL}&underlyingPrice=309.38&underlyingMode=DELAYED&underlyingProvider=alpaca&underlyingAsOf=2026-08-05T19:09:50.316Z`);
  await act(async () => {
    root.render(<SimulatorWorkspace initialType="monte-carlo" />);
  });
  // One macrotask turn: the chain response and the mount-effect calendar day both land.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/tools/monte-carlo');
});

describe('importing a contract from the options chain', () => {
  it('applies a delayed snapshot and confirms it instead of reporting a mismatch', async () => {
    stubChainFetch(chainPayload());
    await mountAtChainLink();

    expect(container.textContent).not.toContain('ข้อมูลสัญญาที่ได้รับกลับมาไม่ตรงกับที่เลือกไว้');
    expect(container.textContent).not.toContain('นำเข้าสัญญาไม่สำเร็จ');
    // The success path lands on the inputs step, showing the leg it just imported.
    expect(container.querySelector('[data-testid="option-legs-form"]')).not.toBeNull();
    expect(container.textContent).toContain(CONTRACT_SYMBOL);
  });

  it('prefills the quoted ask, so no input the engine reads is left at zero', async () => {
    stubChainFetch(chainPayload());
    await mountAtChainLink();

    const premium = container.querySelector<HTMLInputElement>('[data-validation-path="legs.0.entryPremium"]');
    const strike = container.querySelector<HTMLInputElement>('[data-validation-path="legs.0.strike"]');
    const multiplier = container.querySelector<HTMLInputElement>('[data-validation-path="legs.0.multiplier"]');
    expect(premium?.value).toBe('11.65');
    expect(strike?.value).toBe('310');
    expect(multiplier?.value).toBe('100');
    expect(container.querySelector('[data-testid="provider-contract-gaps"]')).toBeNull();
  });

  it('names the missing field when the provider quotes no executable side', async () => {
    stubChainFetch(chainPayload({ bid: null, ask: null }));
    await mountAtChainLink();

    const gaps = container.querySelector('[data-testid="provider-contract-gaps"]');
    expect(gaps?.textContent).toContain('ราคาสัญญาต่อหุ้น (Premium)');
    expect(container.querySelector<HTMLInputElement>('[data-validation-path="legs.0.entryPremium"]')?.value).toBe('');
  });
});
