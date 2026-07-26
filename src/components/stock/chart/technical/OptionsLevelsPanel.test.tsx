// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { optionsUnavailable } from '@/src/lib/analytics/options-sr';
import { OptionsLevelsPanel } from './OptionsLevelsPanel';

const EXPIRATION = '2026-08-21';
function contract(type: 'call' | 'put', strike: number): OptionContract {
  return { contractSymbol: `${type}-${strike}`, underlyingSymbol: 'AAPL', type, expiration: EXPIRATION, strike, bid: null, ask: null, last: null, mark: null, volume: null, openInterest: 123, impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null, inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpha-vantage', asOf: '2026-07-26T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed' };
}
const chain: OptionsChain = { underlyingSymbol: 'AAPL', spot: 203, expiration: EXPIRATION, expirations: [EXPIRATION], calls: [contract('call', 200), contract('call', 205)], puts: [contract('put', 200), contract('put', 205)], provider: 'alpha-vantage', asOf: '2026-07-26T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed', delayedMinutes: null, completeness: 1, warnings: [] };

beforeEach(() => { vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('OptionsLevelsPanel', () => {
  it('renders real provider rows and shows missing Greeks as em dashes', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<OptionsLevelsPanel chain={chain} result={optionsUnavailable('AAPL', EXPIRATION, 'no-open-interest', 'missing', 'alpha-vantage')} loading={false} expirations={[EXPIRATION]} selectedExpiration={EXPIRATION} retryAt={null} currency="$" onExpirationChange={() => undefined} onRetry={() => undefined} />));
    expect(host.textContent).toContain('Call OI');
    expect(host.textContent).toContain('alpha-vantage');
    const call = host.querySelector('button[aria-label="ดูรายละเอียด call strike 200"]') as HTMLButtonElement;
    await act(async () => call.click());
    expect(host.querySelector('[aria-label="รายละเอียดสัญญาออปชัน"]')?.textContent).toContain('Delta—');
    expect(host.querySelector('[aria-label="รายละเอียดสัญญาออปชัน"]')?.textContent).toContain('OI123');
    await act(async () => root.unmount());
  });

  it('renders the handled 429 message and a single cooldown retry control', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<OptionsLevelsPanel chain={null} result={optionsUnavailable('AAPL', null, 'rate-limited', 'raw upstream', 'alpha-vantage')} loading={false} expirations={[]} selectedExpiration={null} retryAt={Date.now() + 30_000} currency="$" onExpirationChange={() => undefined} onRetry={() => undefined} />));
    expect(host.textContent).toContain('ข้อมูลออปชันถูกจำกัดชั่วคราว กรุณาลองใหม่ภายหลัง');
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root.unmount());
  });
});
