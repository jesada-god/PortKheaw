// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { MarketSignalSection } from './MarketSignalSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result: MarketSignalResult = {
  status: 'available',
  signal: 'bullish',
  score: 47,
  confidence: 'Medium',
  confidencePct: 78,
  timeframe: '1D',
  calculatedAt: '2026-07-25T00:00:00.000Z',
  latestCandleAt: '2026-07-24',
  source: 'yahoo-finance-chart',
  freshness: { status: 'end-of-day', asOf: '2026-07-24T20:00:00.000Z', maxAgeSeconds: 21_600 },
  dataPoints: { received: 260, finalized: 259 },
  components: {
    trend: { score: 0.8, weight: 30, coverage: 1, factorsUsed: 6 },
    momentum: { score: 0.5, weight: 25, coverage: 1, factorsUsed: 3 },
    volume: { score: 0.4, weight: 20, coverage: 0.67, factorsUsed: 2 },
    structure: { score: 0.2, weight: 25, coverage: 0.67, factorsUsed: 2 },
  },
  reasons: [
    { id: 'price-ema20', polarity: 'positive', text: 'ราคาอยู่เหนือ EMA20', impact: 1 },
    { id: 'rsi-hot', polarity: 'caution', text: 'RSI 72 — Momentum ค่อนข้างร้อน', impact: 0 },
  ],
  indicators: {
    close: 206.84,
    ema20: 200,
    ema50: 190,
    ema200: 170,
    rsi14: 72,
    macd: 2.1,
    macdSignal: 1.8,
    macdHistogram: 0.3,
    relativeVolume20: 1.4,
    obvTrend: 'rising',
    adx14: 28,
    plusDi14: 31,
    minusDi14: 18,
    nearestSupport: 195,
    nearestResistance: 215,
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MarketSignalSection', () => {
  it('shows icon/text/timeframe and opens the rule-grounded explanation dialog', async () => {
    await act(async () => root.render(<MarketSignalSection result={result} />));
    expect(container.textContent).toContain('Technical Signal · 1D');
    expect(container.textContent).toContain('↗ BULLISH');
    expect(container.textContent).toContain('แนวโน้มขาขึ้น');
    expect(container.textContent).toContain('ไม่ใช่คำแนะนำซื้อขาย');

    const why = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ทำไม'));
    await act(async () => why?.click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('ราคาอยู่เหนือ EMA20');
    expect(dialog?.textContent).toContain('RSI 72 — Momentum ค่อนข้างร้อน');
    expect(dialog?.textContent).toContain('EMA200');
    expect(dialog?.textContent).toContain('Relative Volume 20');
    expect(dialog?.textContent).toContain('Score: +47');
    expect(dialog?.textContent).toContain('Source: yahoo-finance-chart');
  });

  it('does not invent a direction for insufficient data', async () => {
    const insufficient: MarketSignalResult = {
      ...result,
      status: 'insufficient-data',
      signal: null,
      score: null,
      confidence: 'Insufficient',
      confidencePct: 0,
      reason: 'ต้องมี finalized candles เพิ่ม',
    };
    await act(async () => root.render(<MarketSignalSection result={insufficient} />));
    expect(container.textContent).toContain('ข้อมูลไม่เพียงพอ');
    expect(container.textContent).toContain('ต้องมี finalized candles เพิ่ม');
    expect(container.textContent).not.toContain('BULLISH');
  });
});
