import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const card = readFileSync(new URL('./FairValueCard.tsx', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('./FairValueDetailsDrawer.tsx', import.meta.url), 'utf8');
const stock = readFileSync(new URL('../../stock/StockDetailClient.tsx', import.meta.url), 'utf8');

describe('Stock Overview Fair Value contract', () => {
  it('occupies the existing overview slot and preserves feature gating', () => {
    const before = stock.indexOf('beforeFairValue.map');
    const fairValue = stock.indexOf('<FairValueCard', before);
    const after = stock.indexOf('afterFairValue.map', fairValue);
    expect(before).toBeGreaterThan(-1);
    expect(fairValue).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(fairValue);
    expect(stock.slice(fairValue, after)).toContain('enabled={fairValueEnabled}');
  });

  it('shows all required outputs and an accessible calculation drawer', () => {
    for (const label of ['Fair Value', 'Current Price', 'Upside/Downside', 'DCF', 'Forward Multiples', 'Data Quality']) {
      expect(card).toContain(label);
    }
    expect(card).toContain('aria-label="ดูวิธีคำนวณ Fair Value"');
    expect(card).toContain('min-h-11 min-w-11');
    expect(card).toContain('aria-expanded={open}');
    expect(drawer).toContain('<Drawer id={id}');
    expect(drawer).toContain('Inputs และแหล่งข้อมูล');
  });

  it('keeps USD as source of truth and never adds a Fair Value currency toggle', () => {
    expect(card).not.toContain('setCurrency');
    expect(card).not.toContain('convertUsdForDisplay');
    expect(card).toContain('USD source of truth');
    expect(drawer).not.toContain('displayFx');
  });

  it('deduplicates loading at the client layer and aborts stale consumers', () => {
    expect(card.match(/requestFairValue\(/g)).toHaveLength(1);
    expect(card).toContain('const controller = new AbortController()');
    expect(card).toContain('if (current) setResult({ key: requestKey, data, error: null })');
    expect(card).toContain('result?.key === requestKey');
    expect(card).toContain('controller.abort()');
  });
});
