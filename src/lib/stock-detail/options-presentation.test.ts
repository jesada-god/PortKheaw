import { describe, expect, it } from 'vitest';
import { optionsUnavailable } from '@/src/lib/analytics/options-sr';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  OPTIONS_STATUS_LABEL,
  optionsDataStatusLabel,
  optionsProviderLabel,
  presentOptionsProvenance,
  presentOptionsStatus,
} from './options-presentation';

const EXPIRATION = '2026-08-21';

function contract(type: 'call' | 'put', overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    contractSymbol: `${type}-200`, underlyingSymbol: 'AAPL', type, expiration: EXPIRATION, strike: 200,
    bid: null, ask: null, last: null, mark: null, volume: null, openInterest: 500,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD', provider: 'alpaca',
    marketDataProvider: null, marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: null,
    asOf: '2026-07-27T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed', ...overrides,
  };
}

function chain(overrides: Partial<OptionsChain> = {}): OptionsChain {
  return {
    underlyingSymbol: 'AAPL', spot: 203, expiration: EXPIRATION, expirations: [EXPIRATION],
    calls: [contract('call')], puts: [contract('put')], provider: 'alpaca',
    asOf: '2026-07-27T00:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
    delayedMinutes: null, completeness: 1, warnings: [], ...overrides,
  };
}

describe('options status presentation', () => {
  it('uses the shared user-facing vocabulary and design-system tones', () => {
    expect(OPTIONS_STATUS_LABEL.loading).toBe('กำลังโหลดข้อมูล…');
    expect(OPTIONS_STATUS_LABEL.success).toBe('โหลดข้อมูลสำเร็จ');
    expect(OPTIONS_STATUS_LABEL.error).toBe('โหลดข้อมูลไม่สำเร็จ');

    expect(presentOptionsStatus({ expanded: true, loading: true, chain: null, result: null }))
      .toMatchObject({ state: 'loading', label: 'กำลังโหลดข้อมูล…', tone: 'neutral' });
    expect(presentOptionsStatus({ expanded: true, loading: false, chain: chain(), result: null }))
      .toMatchObject({ state: 'success', label: 'โหลดข้อมูลสำเร็จ', tone: 'positive' });
    expect(presentOptionsStatus({
      expanded: true, loading: false, chain: null,
      result: optionsUnavailable('AAPL', null, 'rate-limited', 'HTTP 429 Too Many Requests', 'alpaca'),
    })).toMatchObject({ state: 'error', label: 'โหลดข้อมูลไม่สำเร็จ', tone: 'danger' });
  });

  it('reports a collapsed section as idle so a closed section never claims a load', () => {
    expect(presentOptionsStatus({ expanded: false, loading: false, chain: null, result: null }).state).toBe('idle');
  });

  it('does not report success unless Calls, Puts and Open Interest are usable', () => {
    const withoutOi = chain({
      calls: [contract('call', { openInterest: null })],
      puts: [contract('put', { openInterest: null })],
    });
    const status = presentOptionsStatus({
      expanded: true, loading: false, chain: withoutOi,
      result: optionsUnavailable('AAPL', EXPIRATION, 'no-open-interest', 'missing', 'alpaca'),
    });
    expect(status.state).toBe('error');
  });

  it('separates "this symbol has no options" from "the load failed"', () => {
    expect(presentOptionsStatus({
      expanded: true, loading: false, chain: null,
      result: optionsUnavailable('AAPL', null, 'no-expirations', 'none', 'alpaca'),
    }).state).toBe('empty');
  });

  it('resolves an unsettled expanded section to loading rather than to a failure', () => {
    expect(presentOptionsStatus({ expanded: true, loading: false, chain: null, result: null }).state).toBe('loading');
  });
});

describe('options provenance detail', () => {
  it('keeps provider, delay class, snapshot time and OI freshness available', () => {
    const detail = presentOptionsProvenance(chain(), null);
    expect(detail.source).toBe('Alpaca');
    expect(detail.dataStatus).toBe('ล่าช้า (Delayed)');
    expect(detail.asOf).toBe('2026-07-27T00:00:00.000Z');
    expect(detail.openInterest).toContain('EOD');
    expect(detail.greeks).toContain('ไม่ได้ส่ง IV/Greeks');
    expect(detail.failure).toBeNull();
  });

  it('never claims real time for an options snapshot', () => {
    expect(optionsDataStatusLabel('live')).toBe('ล่าช้า (Delayed)');
    expect(optionsDataStatusLabel('cached')).toContain('Cached');
    expect(optionsDataStatusLabel('stale')).toContain('Stale');
  });

  it('reports Greeks as supplied when the provider actually sent them', () => {
    const withGreeks = chain({ calls: [contract('call', {
      delta: 0.55,
      valuationSource: 'provider',
      marketDataProvider: 'alpaca-options-data',
      marketDataFeed: 'indicative',
    })] });
    expect(presentOptionsProvenance(withGreeks, null).greeks).toContain('ส่ง IV/Greeks มาบางส่วน');
    expect(presentOptionsProvenance(withGreeks, null).source).toContain('Alpaca Options Data (indicative)');
  });

  it('labels deterministic IV/Greeks as calculated by Nexora, not provider-supplied', () => {
    const derived = chain({ calls: [contract('call', {
      delta: 0.55,
      valuationSource: 'nexora-derived',
      marketDataProvider: 'alpaca-options-data',
      marketDataFeed: 'indicative',
    })] });
    const detail = presentOptionsProvenance(derived, null);
    expect(detail.greeks).toContain('คำนวณโดย Nexora');
    expect(detail.greeks).not.toContain('ผู้ให้บริการส่ง');
  });

  it('translates a failure into human copy and never leaks the raw provider message', () => {
    const detail = presentOptionsProvenance(
      null,
      optionsUnavailable('AAPL', null, 'rate-limited', 'HTTP 429 Too Many Requests; Retry-After: 60', 'alpaca'),
    );
    expect(detail.failure).toBe('แหล่งข้อมูลจำกัดจำนวนการเรียกชั่วคราว ระบบจะเว้นระยะก่อนลองใหม่');
    expect(detail.failure).not.toMatch(/429|Retry-After/);
  });

  it('maps provider ids to readable names and falls back to the raw id', () => {
    expect(optionsProviderLabel('alpaca')).toBe('Alpaca');
    expect(optionsProviderLabel('alpha-vantage')).toBe('Alpha Vantage');
    expect(optionsProviderLabel('brand-new')).toBe('brand-new');
    expect(optionsProviderLabel(null)).toBe('ไม่ทราบแหล่งข้อมูล');
  });
});
