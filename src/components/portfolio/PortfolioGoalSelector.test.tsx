// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortfolioGoalCardModel,
  PORTFOLIO_EMPTY_MESSAGE,
  type PortfolioGoalCardModel,
} from '@/src/lib/portfolio/goal-card';
import type { HoldingSummary, PortfolioSummary } from '@/src/lib/portfolio/types';
import { OverviewPortfolioGoalCard } from '@/src/components/dashboard/OverviewPortfolioGoalCard';
import { resolveAnchoredPanel } from '@/src/components/ui/anchored-panel';
import { PortfolioGoalCard, type PortfolioGoalOption } from './PortfolioGoalCard';

/*
 * The goal card's own selector, and what the card does with a portfolio that
 * holds nothing.
 *
 * "พอร์ตที่เลือก" used to name a portfolio the reader could not choose from
 * here — it only switched scope back to whichever portfolio the page had open
 * elsewhere. These drive the real control: press it, pick a different portfolio,
 * and read what the card says afterwards.
 */

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

const holding: HoldingSummary = {
  symbol: 'KHEAW',
  quantity: 2,
  averageCost: 50,
  costBasis: 100,
  marketPrice: 75,
  marketValue: 150,
  realizedGain: 0,
  unrealizedGain: 50,
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

function summaryFor({ empty }: { empty: boolean }): PortfolioSummary {
  return {
    holdings: empty ? [] : [holding],
    cashBalance: 0,
    marketValue: empty ? 0 : 150,
    costBasis: empty ? 0 : 100,
    realizedGain: 0,
    unrealizedGain: empty ? 0 : 50,
    totalValue: empty ? 0 : 150,
    equityMarketValue: empty ? 0 : 150,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: empty ? 0 : 100,
    netTransferredCapital: 0,
    totalGain: empty ? 0 : 50,
    totalGainPercent: empty ? null : 50,
    todayChange: null,
    todayChangePercent: null,
    todayChangeAsOf: null,
    todayChangeSource: null,
    optionPositions: [],
    hasMissingPrices: false,
  };
}

function modelFor(empty: boolean): PortfolioGoalCardModel {
  return buildPortfolioGoalCardModel({
    scope: 'selected',
    summary: summaryFor({ empty }),
    goal: { targetValueUsd: 1_000, targetDate: null },
    activePortfolios: 2,
    totalPortfolios: 2,
  });
}

const options: PortfolioGoalOption[] = [
  { id: 'funded', name: 'พอร์ตร้อยเด้ง', assetCount: 1 },
  { id: 'empty', name: 'พอร์ตเปล่า', assetCount: 0 },
];

const money = (value: number | string | null) => String(value ?? '—');
const signed = (value: number | null) => String(value ?? '—');
const percent = (value: number | null) => (value === null ? '—' : `${value}%`);

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

async function renderCard(overrides: {
  model?: PortfolioGoalCardModel;
  selectedPortfolioId?: string;
  name?: string;
  onSelectPortfolio?: (id: string) => void;
  onScopeChange?: (scope: 'selected' | 'aggregate') => void;
} = {}) {
  await act(async () => root.render(
    <PortfolioGoalCard
      model={overrides.model ?? modelFor(false)}
      selectedPortfolioName={overrides.name ?? 'พอร์ตร้อยเด้ง'}
      portfolios={options}
      selectedPortfolioId={overrides.selectedPortfolioId ?? 'funded'}
      showBalances
      isOnline
      money={money}
      signed={signed}
      percent={percent}
      onScopeChange={overrides.onScopeChange ?? (() => undefined)}
      onSelectPortfolio={overrides.onSelectPortfolio ?? (() => undefined)}
      onEditGoal={() => undefined}
    />,
  ));
}

const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="portfolio-goal-scope-selected"]');
/*
 * The list is portalled to `document.body`, not rendered inside the card, so it
 * cannot be clipped by the card's `overflow-hidden`. Every query for it goes
 * through the document for that reason — a container-scoped query passing again
 * would mean the panel had moved back inside the clipping ancestor.
 */
const list = () => document.body.querySelector('[data-testid="portfolio-goal-portfolio-list"]');
const optionNodes = () => Array.from(document.body.querySelectorAll('[role="option"]'));
const option = (id: string) => document.body.querySelector(`[data-testid="portfolio-goal-option-${id}"]`);

async function click(element: Element | null | undefined) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the พอร์ตที่เลือก control', () => {
  it('is a real selector rather than a label, and says so to assistive tech', async () => {
    await renderCard();
    expect(trigger()?.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(list()).toBeNull();
  });

  it('names the portfolio it is pointed at, not its own function', async () => {
    await renderCard({ selectedPortfolioId: 'funded' });
    // The generic word is gone from the face of the control; it survives only as
    // the accessible name, where it says what the value means.
    expect(trigger()?.textContent).toContain('พอร์ตร้อยเด้ง');
    expect(trigger()?.textContent).not.toContain('พอร์ตที่เลือก');
    expect(trigger()?.getAttribute('aria-label')).toBe('พอร์ตที่เลือก: พอร์ตร้อยเด้ง');
    // The chevron still says it opens.
    expect(trigger()?.querySelector('svg')).not.toBeNull();
  });

  it('follows the selection when the page hands it a different portfolio', async () => {
    await renderCard({ selectedPortfolioId: 'funded' });
    expect(trigger()?.textContent).toContain('พอร์ตร้อยเด้ง');
    await renderCard({ model: modelFor(true), selectedPortfolioId: 'empty', name: 'พอร์ตเปล่า' });
    expect(trigger()?.textContent).toContain('พอร์ตเปล่า');
  });

  it('opens the portfolio list when pressed', async () => {
    await renderCard();
    await click(trigger());

    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(list()).not.toBeNull();
    expect(list()?.getAttribute('role')).toBe('listbox');
    const entries = optionNodes();
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('พอร์ตร้อยเด้ง'),
      expect.stringContaining('พอร์ตเปล่า'),
    ]);
    expect(entries[0]?.getAttribute('aria-selected')).toBe('true');
    expect(entries[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('closes the list again on a second press', async () => {
    await renderCard();
    await click(trigger());
    expect(list()).not.toBeNull();
    await click(trigger());
    expect(list()).toBeNull();
  });

  it('reports the chosen portfolio and closes, without asking the page to navigate', async () => {
    const chosen: string[] = [];
    await renderCard({ onSelectPortfolio: (id) => chosen.push(id) });
    await click(trigger());
    await click(option('empty'));

    expect(chosen.at(-1)).toBe('empty');
    expect(list()).toBeNull();
  });

  it('points the card at a portfolio even when the list is only opened', async () => {
    const chosen: string[] = [];
    await renderCard({ onSelectPortfolio: (id) => chosen.push(id) });
    await click(trigger());
    expect(chosen).toEqual(['funded']);
  });

  it('updates the card with the chosen portfolio’s own data', async () => {
    // What the page does with the callback: swap the model for that portfolio's.
    await renderCard({ model: modelFor(false), selectedPortfolioId: 'funded' });
    expect(container.querySelector('[data-testid="portfolio-goal-return"]')?.textContent)
      .toContain('50%');
    expect(container.querySelector('[data-testid="portfolio-goal-empty"]')).toBeNull();

    await renderCard({ model: modelFor(true), selectedPortfolioId: 'empty' });
    expect(container.querySelector('[data-testid="portfolio-goal-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="portfolio-goal-return"]')).toBeNull();
    expect(trigger()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves the พอร์ตรวม segment doing exactly what it did', async () => {
    const scopes: string[] = [];
    await renderCard({ onScopeChange: (scope) => scopes.push(scope) });
    const aggregate = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'พอร์ตรวม');
    await click(aggregate);
    expect(scopes).toEqual(['aggregate']);
  });
});

/*
 * The placement arithmetic, at the widths the panel used to break at.
 *
 * The old panel was `absolute right-0` inside the card. On a 390px viewport the
 * trigger's right edge sits about 139px in, so a 224px panel resolved to
 * `left: -85` — off the screen, clipped by the card's `overflow-hidden`, with
 * both portfolio names sliced down the middle. These assert the invariant that
 * replaced it: whatever the width and wherever the trigger is, the panel stays
 * inside the viewport on both edges.
 */
describe('the list placement at mobile widths', () => {
  const SELECTOR_MENU_WIDTH = 288;

  it.each([320, 390, 430, 768, 1440])('keeps the panel on screen at %spx', (viewportWidth) => {
    // The trigger lives in a right-aligned control inside a card inset by 12px.
    const right = viewportWidth - 12 - 96;
    const rect = { left: right - 112, right, top: 360, bottom: 396 };
    const placement = resolveAnchoredPanel({
      rect,
      viewportWidth,
      viewportHeight: 844,
      width: SELECTOR_MENU_WIDTH,
      preferredMaxHeight: 320,
      minHeight: 120,
      align: 'end',
    });

    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewportWidth);
    expect(placement.width).toBeGreaterThan(0);
    expect(placement.width).toBeLessThanOrEqual(SELECTOR_MENU_WIDTH);
    // Anchored below the trigger, never over it.
    expect(placement.top).toBeGreaterThanOrEqual(rect.bottom);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(844);
  });

  it('never returns a negative left, wherever the trigger sits', () => {
    for (const viewportWidth of [320, 360, 390, 414, 430]) {
      for (let right = 40; right <= viewportWidth; right += 10) {
        const placement = resolveAnchoredPanel({
          rect: { left: Math.max(0, right - 112), right, top: 300, bottom: 336 },
          viewportWidth,
          viewportHeight: 844,
          width: SELECTOR_MENU_WIDTH,
          preferredMaxHeight: 320,
          minHeight: 120,
          align: 'end',
        });
        expect(placement.left).toBeGreaterThanOrEqual(0);
        expect(placement.left + placement.width).toBeLessThanOrEqual(viewportWidth);
      }
    }
  });

  it('shrinks the panel rather than overflowing a viewport narrower than it', () => {
    const placement = resolveAnchoredPanel({
      rect: { left: 200, right: 308, top: 300, bottom: 336 },
      viewportWidth: 320,
      viewportHeight: 844,
      width: SELECTOR_MENU_WIDTH,
      preferredMaxHeight: 320,
      minHeight: 120,
      align: 'end',
    });
    expect(placement.width).toBeLessThanOrEqual(320 - 16);
    expect(placement.left).toBeGreaterThanOrEqual(8);
  });
});

describe('a portfolio holding nothing', () => {
  it('shows Kheaw with his laptop and the exact sentence, and nothing else', async () => {
    await renderCard({ model: modelFor(true), selectedPortfolioId: 'empty' });
    const empty = container.querySelector('[data-testid="portfolio-goal-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe(PORTFOLIO_EMPTY_MESSAGE);
    expect(PORTFOLIO_EMPTY_MESSAGE).toBe('เพิ่มสินทรัพย์ลงในพอร์ตก่อนนะ');

    const mascot = container.querySelector('img');
    expect(mascot?.getAttribute('src')).toBe('/brand/10_empty_laptop.png');
    expect(mascot?.getAttribute('data-visual-variant')).toBe('emptyPortfolio');
    expect(mascot?.getAttribute('alt')).toContain('โน้ตบุ๊ก');
  });

  it('is centred, with the illustration and the sentence as the whole card body', async () => {
    await renderCard({ model: modelFor(true), selectedPortfolioId: 'empty' });
    const empty = container.querySelector('[data-testid="portfolio-goal-empty"]');
    expect(empty?.getAttribute('class')).toContain('items-center');
    expect(empty?.getAttribute('class')).toContain('justify-center');
    expect(empty?.getAttribute('class')).toContain('text-center');
  });

  it('states no goal progress, no value and no return it does not have', async () => {
    await renderCard({ model: modelFor(true), selectedPortfolioId: 'empty' });
    expect(container.querySelector('[data-testid="portfolio-goal-primary"]')).toBeNull();
    expect(container.querySelector('[data-testid="portfolio-goal-progress-fill"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="portfolio-goal-return"]')).toBeNull();
    expect(container.textContent).not.toContain('ความคืบหน้า');
    expect(container.textContent).not.toContain('ยอดปัจจุบัน');
    expect(container.textContent).not.toContain('0.00%');
  });

  it('keeps the selector reachable, so the reader can leave the empty portfolio', async () => {
    const chosen: string[] = [];
    await renderCard({
      model: modelFor(true),
      selectedPortfolioId: 'empty',
      onSelectPortfolio: (id) => chosen.push(id),
    });
    await click(trigger());
    await click(option('funded'));
    expect(chosen.at(-1)).toBe('funded');
  });

  it('draws the same empty state on the Overview tile', async () => {
    await act(async () => root.render(
      <OverviewPortfolioGoalCard
        model={modelFor(true)}
        money={money}
        signed={signed}
        percent={percent}
        showBalances
      />,
    ));
    const empty = container.querySelector('[data-testid="overview-portfolio-goal-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain(PORTFOLIO_EMPTY_MESSAGE);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/10_empty_laptop.png');
    expect(container.querySelector('[data-testid="overview-portfolio-goal-return"]')).toBeNull();
  });
});

describe('a portfolio holding something', () => {
  it('still shows the ordinary goal content', async () => {
    await renderCard({ model: modelFor(false) });
    expect(container.querySelector('[data-testid="portfolio-goal-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="portfolio-goal-primary"]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="portfolio-goal-progress-fill"]')).not.toBeNull();
    expect(container.textContent).toContain('ความคืบหน้า');
    expect(container.textContent).toContain('ยอดปัจจุบัน');
    expect(container.querySelector('[data-testid="portfolio-goal-return"]')?.textContent)
      .toContain('ผลตอบแทนรวม');
    expect(container.querySelector('img')?.getAttribute('src')).not.toBe('/brand/10_empty_laptop.png');
  });

  it('keeps the mood artwork a return chose, not the empty one', async () => {
    await renderCard({ model: modelFor(false) });
    const card = container.querySelector('[data-testid="portfolio-goal-card"]');
    expect(card?.getAttribute('data-mood')).toBe('strongGain');
    expect(card?.getAttribute('data-special-event')).toBe('gainOver50');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/09_event_gain_over_50.png');
  });
});
