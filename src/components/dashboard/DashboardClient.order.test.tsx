// @vitest-environment jsdom

/**
 * THE READING ORDER, IN A HYDRATED DOM.
 *
 * `section-order.test.ts` proves the LIST is right for all 128 subsets. This
 * proves the PAGE agrees with the list — that every key is actually wired to
 * the component it names, that a section which is off draws nothing at all, and
 * that what a reader scrolls past comes out in document order.
 *
 * Those are different claims, and the gap between them is where this kind of
 * bug lives: an ordering module can be perfect while the render maps two keys
 * to the same node, or renders one outside the run, or leaves an empty wrapper
 * behind a flag. None of that is visible from the list, and none of it is
 * visible from a source scan either — which is why this mounts.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketIndexCard, OverviewDashboardData } from '@/src/lib/overview/types';
import {
  OVERVIEW_ORDER_V1,
  OVERVIEW_ORDER_V2,
  type OverviewSectionKey,
} from '@/src/lib/overview/section-order';
import { buildMarketEventsCardView } from '@/src/lib/market-events/card-view';
import type { MarketEvent } from '@/src/lib/market-events/types';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

/*
 * The page chrome and the news feed are not under test here, and both need
 * things a bare jsdom does not have (a mounted app router, a live fetch). The
 * SECTIONS are real — every one of them is the component the page ships.
 */
vi.mock('@/src/components/layout/Header', () => ({ default: () => <header /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/src/hooks/usePortfolioPrivacy', () => ({
  usePortfolioPrivacy: () => ({ visible: true, toggleVisibility: () => {} }),
}));

const { DashboardClient } = await import('./DashboardClient');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function marketCard(symbol: string, name: string): MarketIndexCard {
  return {
    symbol,
    name,
    proxyLabel: 'ETF อ้างอิง',
    subtitle: `${symbol} · ETF อ้างอิง`,
    instrument: {
      symbol,
      companyName: name,
      exchange: 'NYSE',
      assetType: 'ETF',
      currency: 'USD',
      sector: null,
      industry: null,
      websiteDomain: null,
      logoUrl: null,
      metadataSource: 'test',
      updatedAt: null,
    },
    price: 100,
    currency: 'USD',
    change: 1,
    changePercent: 1,
    session: 'REGULAR',
    sessionLabel: 'ตลาดเปิด',
    status: 'delayed',
    asOf: '2026-12-10T14:00:00.000Z',
    tradingDate: '2026-12-10',
    extended: null,
    freshness: null,
    sparkline: [1, 2, 3],
  };
}

const CALENDAR: MarketEvent[] = [{
  id: 'cpi-2026-12-10',
  kind: 'CPI',
  titleTh: 'เงินเฟ้อผู้บริโภค (CPI)',
  shortTh: 'CPI',
  importance: 'high',
  source: 'BLS',
  referencePeriod: 'พฤศจิกายน 2026',
  at: '2026-12-10T13:30:00.000Z',
  etDisplay: '8:30 a.m. ET',
}];

/**
 * A watchlist row that moves enough to raise a "สิ่งที่เปลี่ยนไป" item, so the
 * whatChanged section has something to draw. `buildOverviewChanges` derives it
 * from these rows — no extra payload, which is the property the overview
 * contract already pins.
 */
const MOVER: MarketIndexCard = {
  ...marketCard('AAA', 'Alpha'),
  change: 9,
  changePercent: 9,
};

interface Toggles {
  marketStatus: boolean;
  marketEvents: boolean;
  upcoming: boolean;
  whatChanged: boolean;
  overviewV2: boolean;
  /** The V2 merged list. Absent leaves the section off, exactly as the flag does. */
  events: boolean;
}

function dashboardData(toggles: Toggles): OverviewDashboardData {
  return {
    generatedAt: '2026-12-10T14:00:00.000Z',
    serviceStatus: {
      level: 'ready',
      label: 'ข้อมูลตลาดพร้อมใช้งาน',
      checkedAt: '2026-12-10T14:00:00.000Z',
      affected: [],
    },
    portfolio: {
      authenticated: false,
      portfolioCount: 0,
      totalPortfolioCount: 0,
      portfolioName: null,
      summary: null,
      baseCurrency: 'USD',
      targetValueUsd: null,
      targetDate: null,
      valuedAt: null,
      todayExchangeDate: null,
      coverage: null,
      portfolios: [],
    },
    usdThbRate: null,
    indices: [marketCard('SPY', 'S&P 500')],
    industries: [],
    watchlist: toggles.whatChanged ? [MOVER] : [],
    watchlistPreview: null,
    breadth: null,
    industryData: {
      state: 'ready',
      classificationUpdatedAt: '2026-12-10T00:00:00.000Z',
      quotesUpdatedAt: null,
      candidateCount: 0,
      completedCount: 0,
      deadlineReached: false,
    },
    newsContext: { portfolioSymbols: [], watchlistSymbols: [], industryNames: [] },
    marketEvents: toggles.marketEvents
      ? buildMarketEventsCardView({ now: '2026-12-10T14:00:00.000Z', events: CALENDAR })
      : null,
    overviewV2: toggles.overviewV2,
    marketStatus: toggles.marketStatus
      ? {
        evaluation: {
          status: 'insufficient',
          label: null,
          rawLabel: null,
          held: false,
          rawRunLength: 0,
          exempt: false,
          regime: null,
          inputs: [],
          missing: [],
          insufficientReason: 'missing-equity-input',
        },
        sessionDate: '2026-12-09',
      } as unknown as OverviewDashboardData['marketStatus']
      : undefined,
    upcoming: toggles.upcoming ? { events: [], total: 0 } : null,
    events: toggles.events
      ? { rows: [], total: 0, coverageNoteTh: null }
      : null,
    limitations: [],
  } as unknown as OverviewDashboardData;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(toggles: Toggles) {
  act(() => root.render(<DashboardClient data={dashboardData(toggles)} />));
}

/**
 * Where each managed section actually is in the document, by a marker only that
 * section draws. `-1` means it is not on the page.
 */
const MARKERS: Record<OverviewSectionKey, string> = {
  marketToday: '#market-overview',
  marketStatus: '[data-testid="market-status-card"]',
  portfolio: '[data-testid="overview-portfolio-line"], [data-section="overview-portfolio-line"]',
  watchlist: '[data-testid="overview-watchlist"]',
  whatChanged: '[data-testid="overview-changes"]',
  marketEvents: '[data-testid="market-events-card"]',
  events: '[data-testid="overview-events"]',
  upcoming: '[data-testid="upcoming-section"]',
  news: '[data-testid="overview-news"]',
};

/** Document order of the sections that rendered, read off the live DOM. */
function renderedOrder(): OverviewSectionKey[] {
  const found: Array<{ key: OverviewSectionKey; position: number }> = [];
  const all = [...container.querySelectorAll('*')];
  for (const [key, selector] of Object.entries(MARKERS) as Array<[OverviewSectionKey, string]>) {
    const node = container.querySelector(selector);
    if (node) found.push({ key, position: all.indexOf(node) });
  }
  return found.sort((left, right) => left.position - right.position).map((item) => item.key);
}

const ALL_ON: Toggles = {
  marketStatus: true,
  marketEvents: true,
  upcoming: true,
  whatChanged: true,
  events: true,
  overviewV2: false,
};

describe('the overview reading order, rendered', () => {
  /*
   * Eight in V1 and six in V2, and the two numbers differ because the orders
   * do: `events` belongs to V2 alone, and `marketStatus` / `upcoming` /
   * `marketEvents` belong to V1 alone. A key that is switched on but absent
   * from the order in force must draw NOTHING, which is what the two counts
   * together assert.
   */
  it('draws every managed section when everything is on', () => {
    render(ALL_ON);
    expect(renderedOrder()).toEqual([...OVERVIEW_ORDER_V1]);
    act(() => root.render(<DashboardClient data={dashboardData({ ...ALL_ON, overviewV2: true })} />));
    expect(renderedOrder()).toEqual([...OVERVIEW_ORDER_V2]);
  });

  it('follows the V1 order with OVERVIEW_V2 off', () => {
    render(ALL_ON);
    expect(renderedOrder()).toEqual([...OVERVIEW_ORDER_V1]);
  });

  it('follows the V2 order with OVERVIEW_V2 on', () => {
    render({ ...ALL_ON, overviewV2: true });
    expect(renderedOrder()).toEqual([...OVERVIEW_ORDER_V2]);
  });

  /*
   * ===========================================================================
   * EVERY SUBSET OF THE FLAGS, IN THE RENDERED DOM
   * ===========================================================================
   * Four togglable sections × both orders = 32 pages, each checked for two
   * things: the sections present are exactly the ones switched on, and they
   * come out in the order the list promises. This is the requirement that the
   * sequence holds when a card vanishes from the MIDDLE, checked against what
   * a browser actually produced rather than against the list that was supposed
   * to produce it.
   */
  for (const overviewV2 of [false, true]) {
    const expectedOrder = overviewV2 ? OVERVIEW_ORDER_V2 : OVERVIEW_ORDER_V1;
    for (const marketStatus of [false, true]) {
      for (const marketEvents of [false, true]) {
        for (const upcoming of [false, true]) {
          for (const whatChanged of [false, true]) {
            const toggles = {
              marketStatus, marketEvents, upcoming, whatChanged, overviewV2, events: true,
            };
            const name = `v2=${overviewV2} status=${marketStatus} events=${marketEvents}`
              + ` upcoming=${upcoming} changed=${whatChanged}`;
            it(`renders the right sections in the right order — ${name}`, () => {
              render(toggles);
              const present = expectedOrder.filter((key) => {
                if (key === 'marketStatus') return marketStatus;
                if (key === 'marketEvents') return marketEvents;
                if (key === 'upcoming') return upcoming;
                if (key === 'whatChanged') return whatChanged;
                return true;
              });
              expect(renderedOrder()).toEqual(present);
            });
          }
        }
      }
    }
  }

  /*
   * A section that is off must leave NOTHING behind — not an empty panel, not a
   * wrapper holding a margin open. The gap is the actual bug: it reads as a
   * card still loading, on a page where nothing is going to arrive.
   */
  it('leaves no empty node where a section was switched off', () => {
    render({
      marketStatus: false,
      marketEvents: false,
      upcoming: false,
      whatChanged: false,
      events: false,
      overviewV2: true,
    });
    for (const selector of [
      MARKERS.marketStatus, MARKERS.marketEvents, MARKERS.upcoming,
      MARKERS.whatChanged, MARKERS.events,
    ]) {
      expect(container.querySelector(selector)).toBeNull();
    }
    // Nothing rendered an empty section element in their place.
    for (const node of container.querySelectorAll('section')) {
      expect(node.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  /*
   * MOBILE AND DESKTOP ARE THE SAME SEQUENCE.
   *
   * The run is one list rendered once — there is no second ordering behind a
   * breakpoint, and no `order-*` utility reordering it in CSS, which is the
   * only way a flex or grid child can end up somewhere other than where the
   * document put it. A reader who learns the page on a phone finds it in the
   * same sequence on a desktop.
   */
  it('has no breakpoint that reorders the run', () => {
    render({ ...ALL_ON, overviewV2: true });
    const order = renderedOrder();
    for (const key of order) {
      const node = container.querySelector(MARKERS[key]);
      expect(node?.className ?? '').not.toMatch(/(^|\s|:)order-/);
      expect(node?.className ?? '').not.toMatch(/flex-col-reverse/);
    }
  });
});
