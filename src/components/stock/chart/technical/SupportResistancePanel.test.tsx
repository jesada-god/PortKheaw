// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelStatistics } from '@/src/lib/analytics/level-statistics';
import { SupportResistancePanel, type SupportResistanceRow } from './SupportResistancePanel';

function statistics(type: 'support' | 'resistance'): LevelStatistics {
  return {
    id: type === 'support' ? 'S1' : 'R1', label: type === 'support' ? 'S1' : 'R1', price: type === 'support' ? 203.8 : 210.9,
    type, touches: type === 'support' ? 14 : 16, successfulHolds: type === 'support' ? 6 : 7,
    breaks: type === 'support' ? 8 : 9, lastTouchTime: Date.UTC(2026, 6, 22) / 1_000,
    holdRate: type === 'support' ? 43 : 44, strength: 'moderate', tolerance: 0.75, interactions: [],
  };
}

function row(side: 'support' | 'resistance'): SupportResistanceRow {
  const stats = statistics(side);
  return { id: stats.id, label: stats.label, price: stats.price, side, distancePercent: side === 'support' ? -1.49 : 1.95, statistics: stats, confirmation: null };
}

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('SupportResistancePanel compact UI', () => {
  it('uses compact support/resistance wording, the accepted price, and no question-mark controls', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<SupportResistancePanel rows={[row('resistance'), row('support')]} acceptedPrice={206.87} priceLabel="header" basisLabel="D1" nearest={{ label: 'S1', price: 203.8, distancePercent: -1.49 }} statisticsReason={null} levelsError={null} currency="$" contextEntitled />));
    expect(host.querySelector('[data-testid="sr-level-R1-summary"]')?.textContent).toBe('ชน 16 · ต้านอยู่ 7 (44%) · ทะลุ 9');
    expect(host.querySelector('[data-testid="sr-level-S1-summary"]')?.textContent).toBe('ชน 14 · รับอยู่ 6 (43%) · หลุด 8');
    expect(host.querySelector('[data-testid="sr-level-R1"]')?.textContent).toContain('R1 แนวต้านที่ 1');
    expect(host.querySelector('[data-testid="sr-level-S1"]')?.textContent).toContain('S1 แนวรับที่ 1');
    expect(host.querySelector('[data-testid="sr-current-price"]')?.textContent).toContain('$206.87');
    expect(host.querySelector('[data-testid="sr-nearest"]')?.textContent).toContain('S1 แนวรับที่ 1 $203.80 · ห่าง 1.49%');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === '?')).toBe(false);
    await act(async () => root.unmount());
  });

  it('opens a compact detail dialog and closes it with Escape while returning focus', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<SupportResistancePanel rows={[row('support')]} acceptedPrice={206.87} priceLabel={null} basisLabel="D1" nearest={null} statisticsReason={null} levelsError={null} currency="$" contextEntitled />));
    const trigger = host.querySelector('button[aria-label="ดูรายละเอียด S1 แนวรับที่ 1"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('รายละเอียด S1 แนวรับที่ 1');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('S1 แนวรับที่ 1 $203.80');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Tolerance');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('รับอยู่');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => root.unmount());
  });

  it('keeps Basic levels and prices but renders no S/R context values', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<SupportResistancePanel rows={[row('resistance'), row('support')]} acceptedPrice={206.87} priceLabel="header" basisLabel="D1" nearest={null} statisticsReason="premium diagnostic" levelsError={null} currency="$" contextEntitled={false} />));

    expect(host.querySelector('[data-testid="sr-level-R1"]')?.textContent).toContain('$210.90');
    expect(host.querySelector('[data-testid="sr-level-S1"]')?.textContent).toContain('$203.80');
    expect(host.querySelector('[data-testid="sr-level-R1-summary"]')).toBeNull();
    expect(host.querySelector('[data-testid="sr-level-S1-summary"]')).toBeNull();
    expect(host.querySelector('[data-testid="sr-level-R1-locked"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sr-level-S1-locked"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sr-statistics-reason"]')).toBeNull();
    expect(host.textContent).not.toContain('ชน 16');
    expect(host.textContent).not.toContain('premium diagnostic');
    expect(host.querySelector('button[aria-label="ดูรายละเอียด R1 แนวต้านที่ 1"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
