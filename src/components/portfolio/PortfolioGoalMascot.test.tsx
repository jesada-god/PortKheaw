// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPortfolioGoalCard } from '@/src/components/dashboard/OverviewPortfolioGoalCard';
import { buildPortfolioGoalCardModel } from '@/src/lib/portfolio/goal-card';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';
import { PortfolioGoalCard } from './PortfolioGoalCard';

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

function cardModel(totalGainPercent: number) {
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
    totalGain: totalGainPercent,
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
});
