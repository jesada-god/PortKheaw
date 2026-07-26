import { describe, expect, it } from 'vitest';
import { optionsPanelErrorLabel, optionsPanelRetrySeconds } from './OptionsChainPanel';

describe('OptionsChainPanel state copy', () => {
  it('shows the live Retry-After countdown for a handled 429', () => {
    expect(optionsPanelErrorLabel('rate-limited', 37))
      .toBe('ข้อมูลออปชันถูกจำกัดชั่วคราว · ลองใหม่ใน 37 วินาที');
  });

  it('distinguishes a truthful no-data state from a rate limit', () => {
    expect(optionsPanelErrorLabel('not-found', 0))
      .toBe('ไม่พบข้อมูลออปชันสำหรับช่วงนี้');
  });

  it('uses the local cooldown when a handled 429 omits Retry-After', () => {
    expect(optionsPanelRetrySeconds('rate-limited', null, 60_000)).toBe(60);
    expect(optionsPanelRetrySeconds('rate-limited', 37, 60_000)).toBe(37);
    expect(optionsPanelRetrySeconds('provider-unavailable', null, 60_000)).toBe(0);
  });
});
