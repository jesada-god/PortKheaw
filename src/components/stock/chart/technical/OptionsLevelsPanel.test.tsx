// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { computeOptionsSupportResistance, optionsUnavailable } from '@/src/lib/analytics/options-sr';
import { OptionsLevelsPanel } from './OptionsLevelsPanel';

const EXPIRATION = '2026-08-21';
const AS_OF = '2026-07-27T00:00:00.000Z';

function contract(type: 'call' | 'put', strike: number, openInterest: number | null): OptionContract {
  return {
    contractSymbol: `${type}-${strike}`, underlyingSymbol: 'AAPL', type, expiration: EXPIRATION, strike,
    bid: null, ask: null, last: null, mark: null, volume: null, openInterest,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpaca',
    asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
  };
}

/** A real-shaped chain: nine strikes, provider open interest, no IV/Greeks (Alpaca's actual shape). */
const STRIKES = [190, 195, 200, 205, 210, 215, 220, 225, 230];
const CALL_OI: Record<number, number> = { 190: 120, 195: 210, 200: 340, 205: 500, 210: 900, 215: 1800, 220: 640, 225: 300, 230: 150 };
const PUT_OI: Record<number, number> = { 190: 1500, 195: 780, 200: 620, 205: 410, 210: 250, 215: 180, 220: 120, 225: 90, 230: 60 };

const chain: OptionsChain = {
  underlyingSymbol: 'AAPL', spot: 208.5, expiration: EXPIRATION, expirations: [EXPIRATION],
  calls: STRIKES.map((strike) => contract('call', strike, CALL_OI[strike]!)),
  puts: STRIKES.map((strike) => contract('put', strike, PUT_OI[strike]!)),
  provider: 'alpaca', asOf: AS_OF, timestampKind: 'receipt', status: 'delayed',
  delayedMinutes: null, completeness: 1, warnings: [],
};

const levels = computeOptionsSupportResistance({
  symbol: 'AAPL', expiration: EXPIRATION, acceptedPrice: 208.5,
  calls: chain.calls, puts: chain.puts, provider: 'alpaca', asOf: AS_OF, status: 'delayed',
}, { nowMs: Date.parse(AS_OF) });

function baseProps() {
  return {
    chain: null as OptionsChain | null,
    result: null,
    loading: false,
    expirations: [] as readonly string[],
    selectedExpiration: null as string | null,
    retryAt: null as number | null,
    currency: '$',
    expanded: true,
    onToggleExpanded: () => undefined,
    onExpirationChange: () => undefined,
    onRetry: () => undefined,
  };
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, root: createRoot(host) };
}

beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('OptionsLevelsPanel success', () => {
  it('renders the real chain: key levels, the OI table and Greeks the provider never sent as em dashes', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <OptionsLevelsPanel {...baseProps()} chain={chain} result={levels} expirations={[EXPIRATION]} selectedExpiration={EXPIRATION} />,
    ));

    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('โหลดข้อมูลสำเร็จ');

    // Walls and Max Pain come from the provider's real open interest.
    expect(levels.status).toBe('available');
    const callWall = host.querySelector('[data-testid="options-card-call-wall"]')!;
    const putWall = host.querySelector('[data-testid="options-card-put-wall"]')!;
    const maxPain = host.querySelector('[data-testid="options-card-max-pain"]')!;
    expect(callWall.textContent).toContain('$215.00');
    expect(callWall.textContent).toContain('OI 1,800');
    expect(putWall.textContent).toContain('$190.00');
    expect(putWall.textContent).toContain('OI 1,500');
    expect(maxPain.textContent).toMatch(/\$\d+\.\d{2}/);

    // Compact strike table near spot, not a dump of the whole chain.
    const headers = [...host.querySelectorAll('thead th')].map((cell) => cell.textContent);
    expect(headers).toEqual(['Strike', 'Call OI', 'Put OI']);
    const bodyRows = host.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBeGreaterThan(0);
    expect(bodyRows.length).toBeLessThanOrEqual(9);

    const call = host.querySelector('button[aria-label="ดูรายละเอียด call strike 210"]') as HTMLButtonElement;
    expect(call.textContent).toBe('900');
    await act(async () => call.click());
    const detail = host.querySelector('[aria-label="รายละเอียดสัญญาออปชัน"]')!;
    expect(detail.textContent).toContain('IV—');
    expect(detail.textContent).toContain('Delta—');
    expect(detail.textContent).toContain('Gamma—');
    expect(detail.textContent).toContain('Theta—');
    expect(detail.textContent).toContain('Vega—');
    expect(detail.textContent).toContain('OI900');
    expect(detail.textContent).toContain('Volume—');
    await act(async () => root.unmount());
  });

  it('keeps provider and delay wording out of the primary UI and inside the ⓘ detail', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <OptionsLevelsPanel {...baseProps()} chain={chain} result={levels} expirations={[EXPIRATION]} selectedExpiration={EXPIRATION} />,
    ));

    expect(host.textContent).not.toMatch(/alpaca|Alpaca|Delayed|DELAYED|cache/i);

    const trigger = host.querySelector('[data-testid="options-provenance-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const provenance = host.querySelector('[data-testid="options-provenance-detail"]')!;
    expect(provenance.textContent).toContain('Alpaca');
    expect(provenance.textContent).toContain('Delayed');
    expect(provenance.textContent).toContain('EOD');
    await act(async () => root.unmount());
  });

  it('still reports success when the chain arrived but carries no open interest', async () => {
    const { host, root } = mount();
    const bare = { ...chain, calls: chain.calls.map((item) => ({ ...item, openInterest: null })), puts: chain.puts.map((item) => ({ ...item, openInterest: null })) };
    await act(async () => root.render(
      <OptionsLevelsPanel {...baseProps()} chain={bare} result={optionsUnavailable('AAPL', EXPIRATION, 'no-open-interest', 'missing', 'alpaca')} expirations={[EXPIRATION]} selectedExpiration={EXPIRATION} />,
    ));
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('โหลดข้อมูลสำเร็จ');
    expect(host.querySelector('[data-testid="options-card-call-wall"]')?.textContent).toContain('—');
    await act(async () => root.unmount());
  });
});

describe('OptionsLevelsPanel loading and failure', () => {
  it('shows the shared loading wording while a request is in flight', async () => {
    const { host, root } = mount();
    await act(async () => root.render(<OptionsLevelsPanel {...baseProps()} loading />));
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('กำลังโหลดข้อมูล…');
    expect(host.querySelector('[data-testid="options-failure"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('shows one bounded retry control and no raw provider diagnostics on failure', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <OptionsLevelsPanel
        {...baseProps()}
        result={optionsUnavailable('AAPL', null, 'rate-limited', 'HTTP 429 Too Many Requests; Retry-After: 60', 'alpaca')}
        retryAt={Date.now() + 30_000}
      />,
    ));

    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
    expect(host.querySelector('[data-testid="options-failure"]')?.textContent).toContain('ไม่สามารถโหลดข้อมูลออปชันได้ในขณะนี้');
    expect(host.textContent).not.toMatch(/429|Retry-After|rate-limited|entitlement|singleFlight|cacheStatus/i);

    const retry = host.querySelector('[data-testid="options-retry"]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="options-retry"]')).toHaveLength(1);
    expect(retry.disabled).toBe(true);

    const trigger = host.querySelector('[data-testid="options-provenance-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(host.querySelector('[data-testid="options-failure-detail"]')?.textContent).toContain('จำกัดจำนวนการเรียก');
    await act(async () => root.unmount());
  });

  it('fires at most one retry per click and re-disables while the request runs', async () => {
    const { host, root } = mount();
    let retries = 0;
    await act(async () => root.render(
      <OptionsLevelsPanel
        {...baseProps()}
        result={optionsUnavailable('AAPL', null, 'chain-unavailable', 'failed', 'alpaca')}
        onRetry={() => { retries += 1; }}
      />,
    ));
    const retry = host.querySelector('[data-testid="options-retry"]') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await act(async () => { retry.click(); retry.click(); });
    expect(retries).toBe(2); // the component never multiplies a click into extra requests

    await act(async () => root.render(
      <OptionsLevelsPanel
        {...baseProps()}
        loading
        result={optionsUnavailable('AAPL', null, 'chain-unavailable', 'failed', 'alpaca')}
        onRetry={() => { retries += 1; }}
      />,
    ));
    expect(host.querySelector('[data-testid="options-retry"]')).toBeNull(); // loading replaces the failure block
    await act(async () => root.unmount());
  });

  it('distinguishes a symbol with no options from a failed load and offers no retry there', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <OptionsLevelsPanel {...baseProps()} result={optionsUnavailable('AAPL', null, 'no-expirations', 'none', 'alpaca')} />,
    ));
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('ไม่มีข้อมูลออปชัน');
    expect(host.querySelector('[data-testid="options-retry"]')).toBeNull();
    await act(async () => root.unmount());
  });
});

describe('OptionsLevelsPanel collapsed', () => {
  it('keeps the section in place, hides the expiration control and reports nothing loaded', async () => {
    const { host, root } = mount();
    await act(async () => root.render(
      <OptionsLevelsPanel {...baseProps()} expanded={false} expirations={[EXPIRATION]} />,
    ));
    expect(host.querySelector('[data-testid="options-levels"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="วันหมดอายุออปชัน"]')).toBeNull();
    expect(host.querySelector('[data-testid="options-status"]')?.textContent).toContain('ยังไม่ได้โหลดข้อมูล');
    expect((host.querySelector('[data-testid="options-expand-toggle"]') as HTMLButtonElement).textContent).toBe('แสดงข้อมูลออปชัน');
    await act(async () => root.unmount());
  });
});
