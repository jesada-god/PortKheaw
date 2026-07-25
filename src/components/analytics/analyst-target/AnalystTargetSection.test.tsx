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
      message: 'Finnhub: API plan ปัจจุบันไม่รองรับ Price Target (403)',
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
  await vi.waitFor(() => expect(container.textContent).not.toContain('Loading Analyst Consensus'));
}

async function openDetails(): Promise<HTMLElement> {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="รายละเอียดราคาเป้าหมาย"]',
  );
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => button?.click());
  expect(button?.getAttribute('aria-expanded')).toBe('true');
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
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
  vi.restoreAllMocks();
});

describe('AnalystTargetSection', () => {
  it('shows a compact Finnhub card and only useful target details', async () => {
    await render(finnhub);
    expect(container.textContent).toContain('Target Price');
    expect(container.textContent).toContain('$150.00');
    expect(container.textContent).toContain('Current $100.00');
    expect(container.textContent).toContain('+50.00%');
    expect(container.textContent).toContain('Source: Finnhub');

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="รายละเอียดราคาเป้าหมาย"]',
    );
    expect(button?.title).toBe('ราคาเป้าหมายจากข้อมูลนักวิเคราะห์ภายนอก ใช้เป็นข้อมูลประกอบ ไม่ได้รับประกันว่าราคาจะไปถึงระดับนี้');
    const dialog = await openDetails();
    expect(dialog.textContent).toContain('รายละเอียดราคาเป้าหมาย');
    expect(dialog.textContent).toContain('ราคาปัจจุบัน');
    expect(dialog.textContent).toContain('+$50.00');
    expect(dialog.textContent).toContain('Potential Upside');
    expect(dialog.textContent).toContain('ข้อมูลล่าสุด');
    expect(dialog.textContent).toContain('Median Target');
    expect(dialog.textContent).toContain('$120.00–$180.00');
    expect(dialog.textContent).toContain('Analyst Count');
    expect(dialog.textContent).toContain('30');
    expect(dialog.textContent).not.toContain('สถานะผู้ให้ข้อมูล');
    expect(dialog.textContent).not.toContain('ชื่อสถาบันรายตัว');

    await act(async () => {
      dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows Alpha target/current/difference/percent/source without invented or entitlement fields', async () => {
    await render(alpha);
    expect(container.textContent).toContain('$140.00');
    expect(container.textContent).toContain('Current $100.00');
    expect(container.textContent).toContain('+40.00%');
    expect(container.textContent).toContain('Source: Alpha Vantage');

    const dialog = await openDetails();
    expect(dialog.textContent).toContain('$140.00');
    expect(dialog.textContent).toContain('$100.00');
    expect(dialog.textContent).toContain('+$40.00');
    expect(dialog.textContent).toContain('+40.00%');
    expect(dialog.textContent).toContain('Alpha Vantage');
    expect(dialog.textContent).not.toMatch(/Median Target|Low–High|Analyst Count/);
    expect(dialog.textContent).not.toMatch(/Finnhub|API plan|not-entitled|403|429|provider error/i);
  });

  it('uses user-friendly stale and rate-limit cache wording', async () => {
    await render({ ...alpha, stale: true, status: 'stale' });
    let dialog = await openDetails();
    expect(dialog.textContent).toContain('ข้อมูลอาจไม่ใช่ข้อมูลล่าสุด');

    await act(async () => root.unmount());
    container.innerHTML = '';
    clearAnalystTargetClientCacheForTests();
    root = createRoot(container);
    await render({
      ...alpha,
      stale: true,
      status: 'stale',
      coverage: [{ ...alpha.coverage[0], status: 'rate-limited', message: '429 raw error' }],
    });
    dialog = await openDetails();
    expect(dialog.textContent).toContain('กำลังใช้ข้อมูลล่าสุดที่บันทึกไว้');
    expect(dialog.textContent).not.toContain('429 raw error');
  });

  it('labels a negative target gap with the existing negative design token', async () => {
    await render({
      ...alpha,
      targetPrice: 80,
      upsideDownsidePct: -20,
    });
    const percent = [...container.querySelectorAll('p')]
      .find((item) => item.textContent === '-20.00%');
    expect(percent?.className).toContain('text-red-300');
    const dialog = await openDetails();
    expect(dialog.textContent).toContain('Potential Downside');
    expect(dialog.textContent).toContain('-$20.00');
  });

  it('shows the no-target state without provider coverage details', async () => {
    await render({
      ...alpha,
      targetPrice: null,
      currentPrice: null,
      upsideDownsidePct: null,
      provider: null,
      providerLabel: null,
      status: 'not-entitled',
    });
    expect(container.textContent).toContain('ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้');
    expect(container.textContent).not.toMatch(/Finnhub|API plan|not-entitled|403/);
  });

  it('never exposes a raw request error to the user', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: '429 Finnhub not-entitled raw provider error' },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })));
    await act(async () => root.render(<AnalystTargetSection symbol="AAPL" enabled />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้');
    });
    expect(container.textContent).not.toMatch(/429|Finnhub|not-entitled|provider error/i);
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

  it('reuses the valid 24h client cache and labels it as saved data', async () => {
    await render(alpha);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AnalystTargetSection symbol="AAPL" enabled />));
    await vi.waitFor(() => expect(container.textContent).toContain('$140.00'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const dialog = await openDetails();
    expect(dialog.textContent).toContain('ข้อมูลที่บันทึกไว้ล่าสุด');
  });
});
