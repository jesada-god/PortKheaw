// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalystConsensusResult } from '@/src/lib/analytics/analyst-target/types';
import { AnalystTargetSection, clearAnalystTargetClientCacheForTests } from './AnalystTargetSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const finnhub: AnalystConsensusResult = {
  symbol: 'AAPL',
  targetPrice: 150,
  medianTarget: 145,
  highTarget: 180,
  lowTarget: 120,
  analystCount: 30,
  currentPrice: 100,
  currentPriceAsOf: '2026-07-25T20:00:00.000Z',
  upsideDownsidePct: 50,
  provider: 'finnhub',
  providerLabel: 'Finnhub',
  currency: 'USD',
  lastUpdated: '2026-07-25',
  cachedAt: '2026-07-26T00:00:00.000Z',
  stale: false,
  status: 'available',
  coverage: [{
    provider: 'finnhub',
    providerLabel: 'Finnhub',
    endpoint: 'stock/price-target',
    status: 'available',
    message: 'Finnhub: ใช้งานได้',
    checkedAt: '2026-07-26T00:00:00.000Z',
  }],
};

const alpha: AnalystConsensusResult = {
  ...finnhub,
  targetPrice: 140,
  medianTarget: null,
  highTarget: null,
  lowTarget: null,
  analystCount: null,
  upsideDownsidePct: 40,
  provider: 'alpha-vantage',
  providerLabel: 'Alpha Vantage',
  lastUpdated: null,
  status: 'fallback',
  coverage: [
    {
      provider: 'finnhub',
      providerLabel: 'Finnhub',
      endpoint: 'stock/price-target',
      status: 'not-entitled',
      message: 'Finnhub: API plan ปัจจุบันไม่รองรับ Price Target',
      checkedAt: '2026-07-26T00:00:00.000Z',
    },
    {
      provider: 'alpha-vantage',
      providerLabel: 'Alpha Vantage',
      endpoint: 'OVERVIEW',
      status: 'available',
      message: 'Alpha Vantage: ใช้งานได้',
      checkedAt: '2026-07-26T00:00:00.000Z',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

async function render(data: AnalystConsensusResult, enabled = true) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
  await act(async () => {
    root.render(<AnalystTargetSection symbol="AAPL" enabled={enabled} />);
  });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  clearAnalystTargetClientCacheForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AnalystTargetSection', () => {
  it('shows real Finnhub mean, detail fields, upside, and source details', async () => {
    await render(finnhub);
    expect(container.textContent).toContain('Analyst Consensus');
    expect(container.textContent).toContain('$150.00');
    expect(container.textContent).toContain('Potential +50.00% · Upside');
    expect(container.textContent).toContain('Median');
    expect(container.textContent).toContain('$120.00–$180.00');
    expect(container.textContent).toContain('30 Analysts');

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="แหล่งข้อมูลที่ใช้วิเคราะห์ Analyst Consensus"]',
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => button?.click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(dialog?.textContent).toContain('✓ Finnhub');
    expect(dialog?.textContent).toContain('ราคาเป้าหมายเฉลี่ย: $150.00');
    expect(dialog?.textContent).toContain('จำนวนนักวิเคราะห์: 30');
    expect(dialog?.textContent).toContain('ผู้ให้ข้อมูลไม่ได้ระบุชื่อสถาบันรายตัว');
    expect(dialog?.textContent).not.toMatch(/Morgan Stanley|Goldman Sachs|JPMorgan/);

    await act(async () => {
      dialog?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows only fields Alpha actually provides and the real Finnhub failure', async () => {
    await render(alpha);
    expect(container.textContent).toContain('$140.00');
    expect(container.textContent).toContain('Alpha fallback');
    expect(container.textContent).not.toContain('Median');
    expect(container.textContent).not.toContain('Range');
    expect(container.textContent).not.toContain('Analysts');

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="แหล่งข้อมูลที่ใช้วิเคราะห์ Analyst Consensus"]',
    );
    await act(async () => button?.click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('✓ Alpha Vantage');
    expect(dialog?.textContent).toContain('สถานะ: ใช้เป็นแหล่งสำรอง');
    expect(dialog?.textContent).toContain('Analyst Target: $140.00');
    expect(dialog?.textContent).toContain('Finnhub: API plan ปัจจุบันไม่รองรับ Price Target');
  });

  it('labels saved stale data instead of presenting it as live', async () => {
    await render({ ...alpha, stale: true, status: 'stale' });
    expect(container.textContent).toContain('ข้อมูลล่าสุดที่บันทึกไว้');
    expect(container.textContent).toContain('Saved data');
  });

  it('labels a negative target gap as potential downside', async () => {
    await render({
      ...alpha,
      targetPrice: 80,
      upsideDownsidePct: -20,
    });
    expect(container.textContent).toContain('Potential -20.00% · Downside');
  });

  it('shows an unavailable state with truthful provider coverage', async () => {
    await render({
      ...alpha,
      targetPrice: null,
      currentPrice: null,
      upsideDownsidePct: null,
      provider: null,
      providerLabel: null,
      status: 'not-entitled',
    });
    expect(container.textContent).toContain('ยังไม่มีราคาเป้าหมายนักวิเคราะห์ที่พร้อมใช้งาน');
    expect(container.textContent).toContain('Finnhub: API plan ปัจจุบันไม่รองรับ Price Target');
  });

  it('hides the entire section when the feature flag is disabled', async () => {
    await render(finnhub, false);
    expect(container.querySelector('section')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not refetch on a React rerender with the same symbol', async () => {
    await render(alpha);
    await act(async () => {
      root.render(<AnalystTargetSection symbol="AAPL" enabled />);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses the valid 24h client cache after the Financials panel remounts', async () => {
    await render(alpha);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AnalystTargetSection symbol="AAPL" enabled />));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('$140.00');
  });
});
