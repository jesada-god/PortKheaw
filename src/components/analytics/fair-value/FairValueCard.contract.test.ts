import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const card = readFileSync(new URL('./FairValueCard.tsx', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('./FairValueDetailsDrawer.tsx', import.meta.url), 'utf8');
const drawerPrimitive = readFileSync(new URL('../../ui/Drawer.tsx', import.meta.url), 'utf8');
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

  it('shows required outputs and progressive disclosure', () => {
    for (const label of ['Fair Value', 'Current Price', 'Upside/Downside', 'DCF', 'Forward Multiples', 'Data Quality']) {
      expect(card).toContain(label);
    }
    expect(card).toContain('aria-label="ดูวิธีคำนวณ Fair Value"');
    expect(card).toContain('min-h-11 min-w-11');
    expect(card).toContain('aria-expanded={open}');
    for (const label of ['สรุป', 'โมเดล', 'ข้อมูลที่ใช้', 'แหล่งที่มา']) {
      expect(drawer).toContain(label);
    }
    expect(drawer).toContain('title="วิธีคำนวณ Fair Value"');
    expect(drawer).toContain('variant="responsive-dialog"');
  });

  it('keeps the responsive dialog inside the viewport and preserves dialog accessibility', () => {
    expect(drawerPrimitive).toContain('max-h-[90dvh]');
    expect(drawerPrimitive).toContain('overflow-x-hidden overflow-y-auto');
    expect(drawerPrimitive).toContain('env(safe-area-inset-bottom)');
    expect(drawerPrimitive).toContain('min-h-11 min-w-11');
    expect(drawerPrimitive).toContain('aria-modal="true"');
    expect(drawerPrimitive).toContain('role="dialog"');
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
