import { describe, expect, it } from 'vitest';
import { optionsPanelErrorLabel, optionsPanelRetrySeconds } from './OptionsChainPanel';

describe('OptionsChainPanel state copy', () => {
  it('shows the live Retry-After countdown for a handled 429', () => {
    expect(optionsPanelErrorLabel('rate-limited', 37))
      .toBe('ข้อมูลออปชันถูกจำกัดชั่วคราว · ลองใหม่ใน 37 วินาที');
  });

  it('distinguishes a truthful no-data state from a rate limit', () => {
    expect(optionsPanelErrorLabel('not-found', 0))
      .toBe('ไม่พบสัญญาออปชัน');
  });

  it('states an entitlement refusal as a permanent account limitation, never as a retryable wait', () => {
    for (const code of ['forbidden', 'entitlement-required', 'unsupported']) {
      const label = optionsPanelErrorLabel(code, 0);
      expect(label).toBe('ผู้ให้บริการปัจจุบันไม่รองรับข้อมูลออปชันสำหรับบัญชีนี้');
      expect(label).not.toMatch(/ชั่วคราว|ลองใหม่/);
    }
  });

  it('never leaks provider plan or pricing detail into production copy', () => {
    for (const code of ['forbidden', 'rate-limited', 'not-found', 'provider-not-configured', undefined]) {
      expect(optionsPanelErrorLabel(code, 30)).not.toMatch(/premium|plan|subscribe|apikey|api key|alpha ?vantage|alpaca/i);
    }
  });

  it('does not put a countdown on a non-rate-limited failure', () => {
    expect(optionsPanelRetrySeconds('forbidden', null, 60_000)).toBe(0);
    expect(optionsPanelRetrySeconds('not-found', null, 60_000)).toBe(0);
  });

  it('uses the local cooldown when a handled 429 omits Retry-After', () => {
    expect(optionsPanelRetrySeconds('rate-limited', null, 60_000)).toBe(60);
    expect(optionsPanelRetrySeconds('rate-limited', 37, 60_000)).toBe(37);
    expect(optionsPanelRetrySeconds('provider-unavailable', null, 60_000)).toBe(0);
  });
});
