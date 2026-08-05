// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPortfolioGoalCard } from '@/src/components/dashboard/OverviewPortfolioGoalCard';
import { buildPortfolioGoalCardModel } from '@/src/lib/portfolio/goal-card';
import type { PortfolioMascotState } from '@/src/lib/portfolio/goal-card';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';
import { PortfolioGoalCard } from './PortfolioGoalCard';
import {
  portfolioGoalMascotAsset,
  portfolioGoalReturnTone,
  portfolioGoalReturnToneClass,
} from './PortfolioGoalMascot';

vi.mock('next/image', () => ({
  default: (props: {
    src: string;
    alt: string;
    className?: string;
    'data-visual-variant'?: string;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt}
      className={props.className}
      data-visual-variant={props['data-visual-variant']}
    />
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assetNames = [
  '01_gain_strong.jpg',
  '02_gain_soft_wink.jpg',
  '03_neutral.jpg',
  '04_loss_soft.jpg',
  '05_loss_big.jpg',
  '06_loss_heavy_cry.jpg',
  '07_event_gain_over_100.jpg',
  '08_event_loss_over_50.jpg',
  '09_event_gain_over_50.jpg',
] as const;

function cardModel(totalGainPercent: number | null) {
  const summary: PortfolioSummary = {
    holdings: [],
    cashBalance: 100,
    marketValue: 0,
    costBasis: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    totalValue: 100,
    equityMarketValue: 0,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: 100,
    netTransferredCapital: 0,
    totalGain: totalGainPercent ?? 0,
    totalGainPercent,
    todayChange: null,
    todayChangePercent: null,
    optionPositions: [],
    hasMissingPrices: false,
  };
  return buildPortfolioGoalCardModel({
    scope: 'selected',
    summary,
    goal: { targetValueUsd: 200, targetDate: null },
    activePortfolios: 1,
    totalPortfolios: 1,
  });
}

const money = (value: number | string | null) => String(value ?? '—');
const signed = (value: number | null) => String(value ?? '—');
const percent = (value: number | null) => value === null ? '—' : `${value}%`;

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

describe('Portfolio Goal mascot rendering', () => {
  it('commits every normal and special visual variant', () => {
    for (const assetName of assetNames) {
      expect(existsSync(resolve(process.cwd(), 'public', 'brand', assetName))).toBe(true);
    }
  });

  it.each([
    ['strongGain', null, '/brand/01_gain_strong.jpg'],
    ['gain', null, '/brand/02_gain_soft_wink.jpg'],
    ['neutral', null, '/brand/03_neutral.jpg'],
    ['smallLoss', null, '/brand/04_loss_soft.jpg'],
    ['loss', null, '/brand/05_loss_big.jpg'],
    ['heavyLoss', null, '/brand/06_loss_heavy_cry.jpg'],
    ['strongGain', 'gainOver100', '/brand/07_event_gain_over_100.jpg'],
    ['heavyLoss', 'lossOver50', '/brand/08_event_loss_over_50.jpg'],
    ['strongGain', 'gainOver50', '/brand/09_event_gain_over_50.jpg'],
  ] as const)('maps %s / %s to %s', (mood, specialEvent, expectedAsset) => {
    const state: PortfolioMascotState = {
      mood,
      source: specialEvent ? 'total' : 'today',
      specialEvent,
      percent: 1,
      message: 'test',
    };
    expect(portfolioGoalMascotAsset(state)).toBe(expectedAsset);
  });

  it.each([
    [1, 'positive', 'text-positive'],
    [-1, 'negative', 'text-negative'],
    [0, 'neutral', 'text-neutral-original'],
    [null, 'neutral', 'text-neutral-original'],
    [Number.NaN, 'neutral', 'text-neutral-original'],
  ] as const)('maps return value %s to semantic tone %s', (value, tone, className) => {
    expect(portfolioGoalReturnTone(value)).toBe(tone);
    expect(portfolioGoalReturnToneClass(value, 'text-neutral-original')).toBe(className);
  });

  it('updates mood, special event, and visual asset on rerender', async () => {
    await act(async () => root.render(
      <OverviewPortfolioGoalCard
        model={cardModel(12.51)}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />,
    ));

    const card = () => container.querySelector('[data-testid="overview-portfolio-goal-card"]');
    expect(card()?.getAttribute('data-mood')).toBe('strongGain');
    expect(card()?.getAttribute('data-mood-source')).toBe('total');
    expect(card()?.getAttribute('data-special-event')).toBe('none');
    expect(container.querySelector('img')?.getAttribute('data-visual-variant')).toBe('strongGain');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/01_gain_strong.jpg');

    await act(async () => root.render(
      <OverviewPortfolioGoalCard
        model={cardModel(-50)}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />,
    ));

    expect(card()?.getAttribute('data-mood')).toBe('heavyLoss');
    expect(card()?.getAttribute('data-special-event')).toBe('lossOver50');
    expect(container.querySelector('img')?.getAttribute('data-visual-variant')).toBe('lossOver50');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/08_event_loss_over_50.jpg');
  });

  it('normalizes all nine visible silhouettes to the normal mascot body mass', async () => {
    const visibleAreas = await Promise.all(assetNames.map(async (assetName) => {
      const { data, info } = await sharp(resolve(process.cwd(), 'public', 'brand', assetName))
        .raw().toBuffer({ resolveWithObject: true });
      let count = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        const distance = Math.abs(data[offset] - 21) + Math.abs(data[offset + 1] - 27) + Math.abs(data[offset + 2] - 40);
        if (distance > 45) count += 1;
      }
      return count;
    }));
    const median = [...visibleAreas].sort((a, b) => a - b)[4];
    for (const area of visibleAreas) expect(area / median).toBeGreaterThan(0.72);
    for (const area of visibleAreas) expect(area / median).toBeLessThan(1.28);
  });

  it('gives Overview and Portfolio identical state for the same selected scope', async () => {
    const model = cardModel(50);
    await act(async () => root.render(<>
      <OverviewPortfolioGoalCard
        model={model}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />
      <PortfolioGoalCard
        model={model}
        selectedPortfolioName="Kheaw"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onEditGoal={() => undefined}
      />
    </>));

    const overview = container.querySelector('[data-testid="overview-portfolio-goal-card"]');
    const portfolio = container.querySelector('[data-testid="portfolio-goal-card"]');
    for (const attribute of ['data-mood', 'data-mood-source', 'data-special-event']) {
      expect(overview?.getAttribute(attribute)).toBe(portfolio?.getAttribute(attribute));
    }
    const variants = Array.from(container.querySelectorAll('img'))
      .map((image) => image.getAttribute('data-visual-variant'));
    expect(variants).toEqual(['gainOver50', 'gainOver50']);
  });

  it.each([
    [12.51, 'positive', 'text-positive'],
    [-12.51, 'negative', 'text-negative'],
    [0, 'neutral', null],
  ] as const)('uses matching %s return colors in Overview and Portfolio', async (value, tone, semanticClass) => {
    const model = cardModel(value);
    await act(async () => root.render(<>
      <OverviewPortfolioGoalCard
        model={model}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />
      <PortfolioGoalCard
        model={model}
        selectedPortfolioName="Kheaw"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onEditGoal={() => undefined}
      />
    </>));

    const overview = container.querySelector('[data-testid="overview-portfolio-goal-return"]');
    const portfolio = container.querySelector('[data-testid="portfolio-goal-return"]');
    expect(overview?.getAttribute('data-return-tone')).toBe(tone);
    expect(portfolio?.getAttribute('data-return-tone')).toBe(tone);
    if (semanticClass) {
      expect(overview?.classList.contains(semanticClass)).toBe(true);
      expect(portfolio?.classList.contains(semanticClass)).toBe(true);
    } else {
      expect(overview?.classList.contains('text-positive')).toBe(false);
      expect(overview?.classList.contains('text-negative')).toBe(false);
      expect(portfolio?.classList.contains('text-positive')).toBe(false);
      expect(portfolio?.classList.contains('text-negative')).toBe(false);
    }
  });

  it('keeps unavailable and hidden returns neutral', async () => {
    expect(portfolioGoalReturnTone(null)).toBe('neutral');

    await act(async () => root.render(
      <OverviewPortfolioGoalCard
        model={cardModel(12.51)}
        money={money}
        signed={signed}
        percent={percent}
        showBalances={false}
      />,
    ));

    const hidden = container.querySelector('[data-testid="overview-portfolio-goal-return"]');
    expect(hidden?.getAttribute('data-return-tone')).toBe('neutral');
    expect(hidden?.classList.contains('text-positive')).toBe(false);
    expect(hidden?.classList.contains('text-negative')).toBe(false);

    await act(async () => root.render(
      <OverviewPortfolioGoalCard
        model={cardModel(null)}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />,
    ));
    expect(container.querySelector('[data-testid="overview-portfolio-goal-return"]')).toBeNull();
    expect(container.querySelector('[data-mood-source="none"]')).not.toBeNull();
  });
});
