// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  'kheaw-goal-strong-gain.png',
  'kheaw-goal-gain.png',
  'kheaw-goal-neutral.png',
  'kheaw-goal-small-loss.png',
  'kheaw-goal-loss.png',
  'kheaw-goal-heavy-loss.png',
  'kheaw-goal-event-loss-over-50.png',
  'kheaw-goal-event-gain-over-50.png',
  'kheaw-goal-event-gain-over-100.png',
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
    ['strongGain', null, '/brand/kheaw-goal-strong-gain.png'],
    ['gain', null, '/brand/kheaw-goal-gain.png'],
    ['neutral', null, '/brand/kheaw-goal-neutral.png'],
    ['smallLoss', null, '/brand/kheaw-goal-small-loss.png'],
    ['loss', null, '/brand/kheaw-goal-loss.png'],
    ['heavyLoss', null, '/brand/kheaw-goal-heavy-loss.png'],
    ['strongGain', 'gainOver100', '/brand/kheaw-goal-event-gain-over-100.png'],
    ['heavyLoss', 'lossOver50', '/brand/kheaw-goal-event-loss-over-50.png'],
    ['strongGain', 'gainOver50', '/brand/kheaw-goal-event-gain-over-50.png'],
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
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/kheaw-goal-strong-gain.png');

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
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/kheaw-goal-event-loss-over-50.png');
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
