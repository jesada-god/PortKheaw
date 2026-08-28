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
  '01_gain_strong.png',
  '02_gain_soft_wink.png',
  '03_neutral.png',
  '04_loss_soft.png',
  '05_loss_big.png',
  '06_loss_heavy_cry.png',
  '07_event_gain_over_100.png',
  '08_event_loss_over_50.png',
  '09_event_gain_over_50.png',
  '10_empty_laptop.png',
] as const;

/**
 * Widest scanline of the largest component of `mask` — Kheaw's body base.
 * Detached confetti, lightning and warning signs form their own components and
 * are ignored, which is what makes this a body measurement rather than an
 * artwork measurement.
 */
function widestComponent(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length);
  let best = { count: 0, width: 0 };
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    const rowMin = new Int32Array(height).fill(width);
    const rowMax = new Int32Array(height).fill(-1);
    let cursor = 0;
    let count = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          const next = yy * width + xx;
          if (mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
        }
      }
    }
    if (count <= best.count) continue;
    let widest = 0;
    for (let y = 0; y < height; y += 1) {
      if (rowMax[y] < 0) continue;
      widest = Math.max(widest, rowMax[y] - rowMin[y] + 1);
    }
    best = { count, width: widest };
  }
  return best.width;
}

/**
 * Kheaw's body width in an exported asset, in that asset's own pixels.
 *
 * Two masks, and the narrower one wins when they disagree by more than a tenth.
 * The silhouette is the right measurement for a mascot drawn on his own — it
 * includes the dark outline that is part of how big he reads. It is the wrong
 * one the moment a prop is drawn across him: the empty-state Kheaw holds a
 * laptop welded to his silhouette, and measuring that gives 383px of
 * body-plus-laptop against a real body of 310px. Kheaw is always a saturated
 * colour and the laptop never is, so chroma is what separates them.
 *
 * This mirrors `scripts/normalize-kheaw-assets.mjs` on purpose: the assertion is
 * that the shipped files are the size the build tool claims, measured the same
 * way, and a copy that agreed with the tool by construction would assert nothing.
 */
async function mascotBodyWidth(assetName: string) {
  const { data, info } = await sharp(resolve(process.cwd(), 'public', 'brand', assetName))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const silhouette = new Uint8Array(width * height);
  const coloured = new Uint8Array(width * height);
  for (let index = 0; index < silhouette.length; index += 1) {
    const offset = index * channels;
    if (data[offset + 3] <= 24) continue;
    silhouette[index] = 1;
    const peak = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    const trough = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    if (peak > 60 && peak - trough > 40) coloured[index] = 1;
  }
  const opaqueWidth = widestComponent(silhouette, width, height);
  const colouredWidth = widestComponent(coloured, width, height);
  return opaqueWidth > colouredWidth * 1.1 ? colouredWidth : opaqueWidth;
}

/**
 * One share, so the model is about a portfolio that holds something. A holding
 * list of nothing is the empty state now, and the empty state deliberately has
 * no mood, no return and no progress to assert on.
 */
const holding = {
  symbol: 'KHEAW',
  quantity: 1,
  averageCost: 100,
  costBasis: 100,
  marketPrice: 100,
  marketValue: 100,
  realizedGain: 0,
  unrealizedGain: 0,
  allocation: 100,
  priceCached: false,
  priceStale: false,
  priceSource: 'test',
  priceAsOf: '2026-08-11T03:00:00.000Z',
  todayChange: null,
  todayChangePercent: null,
  todayChangeAsOf: null,
  todayChangeSource: null,
  lots: [],
  transactions: [],
};

function cardModel(totalGainPercent: number | null) {
  const summary: PortfolioSummary = {
    holdings: [holding],
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
    todayChangeAsOf: null,
    todayChangeSource: null,
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

/** The same portfolio with nothing in it: no holdings, no contracts, no value. */
function emptyCardModel() {
  return buildPortfolioGoalCardModel({
    scope: 'selected',
    summary: {
      holdings: [],
      cashBalance: 0,
      marketValue: 0,
      costBasis: 0,
      realizedGain: 0,
      unrealizedGain: 0,
      totalValue: 0,
      equityMarketValue: 0,
      optionsMarketValue: 0,
      optionRemainingCost: 0,
      netDepositedCapital: 0,
      netTransferredCapital: 0,
      totalGain: 0,
      totalGainPercent: null,
      todayChange: null,
      todayChangePercent: null,
      todayChangeAsOf: null,
      todayChangeSource: null,
      optionPositions: [],
      hasMissingPrices: false,
    },
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

  it.each(assetNames)('ships %s with a real alpha channel and no baked background', async (assetName) => {
    const path = resolve(process.cwd(), 'public', 'brand', assetName);
    const metadata = await sharp(path).metadata();
    expect(metadata.hasAlpha).toBe(true);

    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    // Every corner is fully see-through: a flattened export would show the card
    // colour here as an opaque rectangle.
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
      expect(alphaAt(x, y)).toBe(0);
    }
    let transparent = 0;
    for (let offset = 3; offset < data.length; offset += info.channels) {
      if (data[offset] === 0) transparent += 1;
    }
    expect(transparent / (info.width * info.height)).toBeGreaterThan(0.3);
  });

  it.each([
    ['strongGain', null, '/brand/01_gain_strong.png'],
    ['gain', null, '/brand/02_gain_soft_wink.png'],
    ['neutral', null, '/brand/03_neutral.png'],
    ['smallLoss', null, '/brand/04_loss_soft.png'],
    ['loss', null, '/brand/05_loss_big.png'],
    ['heavyLoss', null, '/brand/06_loss_heavy_cry.png'],
    ['strongGain', 'gainOver100', '/brand/07_event_gain_over_100.png'],
    ['heavyLoss', 'lossOver50', '/brand/08_event_loss_over_50.png'],
    ['strongGain', 'gainOver50', '/brand/09_event_gain_over_50.png'],
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
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/01_gain_strong.png');

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
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/08_event_loss_over_50.png');
  });

  it('renders every mascot on the same square canvas', async () => {
    for (const assetName of assetNames) {
      const metadata = await sharp(resolve(process.cwd(), 'public', 'brand', assetName)).metadata();
      expect(metadata.width).toBe(metadata.height);
      expect(metadata.width).toBe(512);
    }
  });

  it('gives every variant, event and empty-state ones included, the same visible body width', async () => {
    const widths: number[] = [];
    for (const assetName of assetNames) widths.push(await mascotBodyWidth(assetName));
    const ordinary = widths.slice(0, 6);
    const median = [...widths].sort((left, right) => left - right)[4];
    expect(median).toBeGreaterThan(0);
    for (const width of widths) {
      expect(width / median).toBeGreaterThan(0.97);
      expect(width / median).toBeLessThan(1.03);
    }
    // The event artwork draws a smaller Kheaw at source; after normalisation it
    // must never come out smaller than the ordinary moods.
    const smallestOrdinary = Math.min(...ordinary);
    for (const width of widths.slice(6)) expect(width).toBeGreaterThanOrEqual(smallestOrdinary * 0.98);
  });

  /*
   * The empty-state variant is the one the naive measurement gets wrong, so it
   * gets its own assertion rather than only being averaged into the one above.
   * A regression here does not fail the size check by much — it fails it by
   * shipping a Kheaw at four-fifths of himself, which is exactly the amount that
   * reads as "smaller" without reading as "broken".
   */
  it('draws the empty-state Kheaw at the body size of the ordinary moods, laptop excluded', async () => {
    const empty = await mascotBodyWidth('10_empty_laptop.png');
    const neutral = await mascotBodyWidth('03_neutral.png');
    expect(empty / neutral).toBeGreaterThan(0.98);
    expect(empty / neutral).toBeLessThan(1.02);

    // What the measurement would have said if the prop counted as body.
    const { data, info } = await sharp(resolve(process.cwd(), 'public', 'brand', '10_empty_laptop.png'))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const silhouette = new Uint8Array(info.width * info.height);
    for (let index = 0; index < silhouette.length; index += 1) {
      if (data[index * info.channels + 3] > 24) silhouette[index] = 1;
    }
    const withLaptop = widestComponent(silhouette, info.width, info.height);
    expect(withLaptop).toBeGreaterThan(empty * 1.1);
  });

  it('draws the empty state in the hero box while every mood keeps the default one', async () => {
    const emptyModel = emptyCardModel();
    expect(emptyModel.isEmpty).toBe(true);
    await act(async () => root.render(
      <PortfolioGoalCard
        model={emptyModel}
        selectedPortfolioName="Kheaw"
        portfolios={[{ id: 'portfolio-1', name: 'Kheaw', assetCount: 0 }]}
        selectedPortfolioId="portfolio-1"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onSelectPortfolio={() => undefined}
        onEditGoal={() => undefined}
      />,
    ));
    const emptyClass = container.querySelector('img')?.getAttribute('class');

    await act(async () => root.render(
      <PortfolioGoalCard
        model={cardModel(12.51)}
        selectedPortfolioName="Kheaw"
        portfolios={[{ id: 'portfolio-1', name: 'Kheaw', assetCount: 1 }]}
        selectedPortfolioId="portfolio-1"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onSelectPortfolio={() => undefined}
        onEditGoal={() => undefined}
      />,
    ));
    /*
     * Different boxes, deliberately. The empty card has nothing in it but Kheaw,
     * so he is drawn at hero scale there; beside the goal figures he is drawn at
     * their scale. What must not differ is the body inside the artwork, and that
     * is asserted on the files themselves above — never corrected for in CSS.
     */
    const moodClass = container.querySelector('img')?.getAttribute('class');
    expect(moodClass).toContain('h-28 sm:h-36 lg:h-44');
    expect(emptyClass).toContain('h-36 sm:h-44 lg:h-48');
    expect(moodClass).not.toBe(emptyClass);
    // Both keep the same fit rules, so neither is cropped or stretched.
    for (const value of [emptyClass, moodClass]) {
      expect(value).toContain('aspect-square');
      expect(value).toContain('w-auto max-w-full object-contain');
    }
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
        portfolios={[{ id: 'portfolio-1', name: 'Kheaw', assetCount: 1 }]}
        selectedPortfolioId="portfolio-1"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onSelectPortfolio={() => undefined}
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
        portfolios={[{ id: 'portfolio-1', name: 'Kheaw', assetCount: 1 }]}
        selectedPortfolioId="portfolio-1"
        showBalances
        isOnline
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={() => undefined}
        onSelectPortfolio={() => undefined}
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
