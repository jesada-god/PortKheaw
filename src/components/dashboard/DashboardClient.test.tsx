// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MarketBreadth,
  MarketIndexCard,
  OverviewDashboardData,
} from '@/src/lib/overview/types';

/**
 * Covers the two interactions the overview grew: a market card that opens the
 * instrument it names, and an industry section that shows Kheaw — once — while
 * its ranking is gathered, and stops showing it however that gathering ends.
 */

const navigations: string[] = [];

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        navigations.push(href);
        rest.onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/src/components/news/NewsFeed', () => ({ NewsFeed: () => <div /> }));
// The page chrome is not under test and expects a mounted app router.
vi.mock('@/src/components/layout/Header', () => ({ default: () => <header /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => navigations.push(href), refresh: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/src/hooks/usePortfolioPrivacy', () => ({
  usePortfolioPrivacy: () => ({ visible: true, toggleVisibility: () => {} }),
}));

import { DashboardClient } from './DashboardClient';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function marketCard(symbol: string, name: string): MarketIndexCard {
  return {
    symbol,
    name,
    proxyLabel: 'ETF อ้างอิง',
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
    asOf: '2026-08-06T14:00:00.000Z',
    tradingDate: '2026-08-06',
    extended: null,
    freshness: null,
    sparkline: [1, 2, 3],
  };
}

function watchlistPrice(symbol: string, extendedChangePercent: number): MarketIndexCard {
  return {
    ...marketCard(symbol, `${symbol} Corp`),
    extended: {
      label: 'หลังตลาด',
      price: 101,
      change: extendedChangePercent,
      changePercent: extendedChangePercent,
      asOf: '2026-08-06T21:00:00.000Z',
    },
  };
}

function dashboardData(
  industryState: OverviewDashboardData['industryData']['state'],
): OverviewDashboardData {
  return {
    generatedAt: '2026-08-06T14:00:00.000Z',
    serviceStatus: {
      level: 'ready',
      label: 'ข้อมูลตลาดพร้อมใช้งาน',
      checkedAt: '2026-08-06T14:00:00.000Z',
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
      coverage: null,
      portfolios: [],
    },
    usdThbRate: null,
    indices: [marketCard('SPY', 'S&P 500'), marketCard('BTC-USD', 'Bitcoin')],
    industries: [],
    watchlist: [],
    breadth: null,
    industryData: {
      state: industryState,
      classificationUpdatedAt: '2026-08-06T00:00:00.000Z',
      quotesUpdatedAt: null,
      candidateCount: 0,
      completedCount: 0,
      deadlineReached: false,
    },
    newsContext: { portfolioSymbols: [], watchlistSymbols: [], industryNames: [] },
    limitations: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigations.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(data: OverviewDashboardData) {
  act(() => root.render(<DashboardClient data={data} />));
}

function marketCards(): HTMLAnchorElement[] {
  return [...container.querySelectorAll('#market-overview a')] as HTMLAnchorElement[];
}

/**
 * Runs the loader's timers to completion.
 *
 * Stepped rather than one long jump: each `act` flush advances the loading state
 * machine by a single transition (armed → visible → leaving → hidden), so a
 * single large advance would stop at the first one and read as "stuck".
 */
async function settleLoaders(steps = 6) {
  for (let step = 0; step < steps; step += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  }
}

describe('market overview cards', () => {
  it('opens the Stock Detail page of the mapped symbol, crypto included', () => {
    render(dashboardData('ready'));
    const [spy, bitcoin] = marketCards();
    expect(spy?.getAttribute('href')).toBe('/stock/SPY');
    expect(bitcoin?.getAttribute('href')).toBe('/stock/BTC-USD');
    expect(spy?.getAttribute('aria-label')).toContain('S&P 500');

    act(() => spy!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(navigations).toEqual(['/stock/SPY']);
  });

  it('is reachable by keyboard with Space as well as Enter', () => {
    render(dashboardData('ready'));
    const [spy] = marketCards();
    expect(spy?.tabIndex).toBeGreaterThanOrEqual(0);

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => { spy!.dispatchEvent(space); });
    expect(space.defaultPrevented).toBe(true);
    expect(navigations).toEqual(['/stock/SPY']);
  });

  it('holds no nested interactive element inside a card', () => {
    render(dashboardData('ready'));
    for (const card of marketCards()) {
      expect(card.querySelector('a, button, input, select, textarea')).toBeNull();
    }
  });

  it('refreshes the section without navigating', () => {
    render(dashboardData('ready'));
    const refresh = container.querySelector('#market-overview button') as HTMLButtonElement | null;
    expect(refresh?.getAttribute('aria-label')).toBe('โหลดข้อมูลส่วนนี้ใหม่');
    act(() => refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(navigations).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/market/overview/section?section=market',
      expect.anything(),
    );
  });
});

describe('watchlist after-hours direction colors', () => {
  it('colors only the directional value for gains, losses, and zero', () => {
    const data = dashboardData('ready');
    data.watchlist = [
      watchlistPrice('GAIN', 1.25),
      watchlistPrice('LOSS', -1.25),
      watchlistPrice('FLAT', 0),
    ];
    render(data);

    const expectedClasses = {
      GAIN: 'text-[var(--positive)]',
      LOSS: 'text-[var(--negative)]',
      FLAT: 'text-[var(--text-muted)]',
    } as const;

    for (const [symbol, expectedClass] of Object.entries(expectedClasses)) {
      const value = container.querySelector(`[data-testid="watchlist-extended-change-${symbol}"]`);
      expect(value?.className).toContain(expectedClass);
      expect(value?.parentElement?.className).toContain('text-[var(--text-secondary)]');
      expect(value?.parentElement?.textContent).toContain('หลังตลาด 101.00');
    }
  });
});

describe('อุตสาหกรรมเด่น loading', () => {
  const industrySection = () => [...container.querySelectorAll('section')]
    .find((section) => section.textContent?.includes('อุตสาหกรรมเด่นวันนี้'))!;
  const kheaw = () => industrySection().querySelector('.kheaw-loader');
  const skeletons = () => industrySection().querySelectorAll('.animate-pulse');

  it('shows Kheaw — and nothing else — once the grace has elapsed', async () => {
    vi.useFakeTimers();
    render(dashboardData('refreshing'));

    // Inside the grace: space is held, no mascot yet.
    expect(kheaw()?.getAttribute('data-kheaw-loader')).toBe('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    const loader = industrySection().querySelector('[role="status"]');
    expect(loader?.textContent).toContain('กำลังรวบรวมราคาช่วงตลาดปกติ');
    expect(skeletons()).toHaveLength(0);
    /*
     * The shared mascot, not a copy: `kheaw-loader` is the class the reduced
     * motion rules in `app/globals.css` target, so this section inherits the
     * still-mascot behaviour asserted in `KheawLoader.motion.test.ts`.
     */
    expect(loader?.className).toContain('kheaw-loader');
    expect(loader?.querySelector('.kheaw-loader__mascot')).not.toBeNull();
  });

  it('never mounts the mascot for a section that is already ready', () => {
    render(dashboardData('ready'));
    expect(industrySection().querySelector('[role="status"]')).toBeNull();
    expect(skeletons()).toHaveLength(0);
  });

  it('leaves the loader and shows the empty state when the request fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(dashboardData('refreshing'));

    await settleLoaders();

    expect(industrySection().querySelector('[role="status"]')).toBeNull();
    expect(industrySection().textContent).toContain('ข้อมูลยังไม่เพียงพอสำหรับจัดอันดับ');
  });

  it('reserves the section height so the page does not jump', () => {
    render(dashboardData('refreshing'));
    const reserved = industrySection().querySelector('.min-h-\\[176px\\]');
    expect(reserved).not.toBeNull();
  });

  it('requests the ranking once, not once per render', async () => {
    vi.useFakeTimers();
    const data = dashboardData('refreshing');
    render(data);
    render(data);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const industryCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([url]) => String(url).includes('section=industries'));
    expect(industryCalls).toHaveLength(1);
  });
});

/**
 * The signed-out introduction: it exists for a visitor who has never seen the
 * product, and it must not become a landing page that a signed-in reader has to
 * scroll past to reach their own portfolio.
 */
describe('public value proposition', () => {
  function intro(): HTMLElement | null {
    return container.querySelector('section[aria-labelledby="portkheaw-intro"]');
  }

  it('introduces the product to a signed-out visitor and links to sign-up', () => {
    render(dashboardData('ready'));
    const section = intro();
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('ลงทุนให้เห็นภาพมากขึ้น ไม่ต้องเปิดหลายแอป');
    expect(section!.textContent).toContain('รู้ว่าพอร์ตเป็นยังไง');
    expect(section!.textContent).toContain('เข้าใจหุ้นก่อนตัดสินใจ');
    expect(section!.textContent).toContain('ลองก่อนลงเงินจริง');
    expect(section!.textContent).toContain('ไม่ต้องผูกบัตร');

    const cta = section!.querySelector('a') as HTMLAnchorElement | null;
    expect(cta?.textContent).toContain('เริ่มใช้ฟรี');
    expect(cta?.getAttribute('href')).toBe('/auth/sign-up');
  });

  it('stays out of the way once the reader is signed in', () => {
    const data = dashboardData('ready');
    render({ ...data, portfolio: { ...data.portfolio, authenticated: true } });
    expect(intro()).toBeNull();
  });

  it('keeps the market overview on the same page, above the fold of the scroll', () => {
    render(dashboardData('ready'));
    // The dashboard is not replaced by the introduction — the live sections are
    // still rendered, and the introduction is only the first of them.
    expect(container.querySelector('#market-overview')).not.toBeNull();
    const sections = [...container.querySelectorAll('main > section, main > div > section')];
    expect(sections[0]?.getAttribute('aria-labelledby')).toBe('portkheaw-intro');
  });
});

/**
 * Market breadth run diagnostics belong to the run, not to the reader's first
 * glance. They stay reachable — transparency about coverage is the point — but
 * behind a disclosure rather than as a debug line on the home screen.
 */
describe('market breadth data health', () => {
  function breadth(): MarketBreadth {
    return {
      advancing: 300,
      declining: 200,
      unchanged: 50,
      validCount: 550,
      universeCount: 578,
      returnedCount: 560,
      failedCount: 1,
      staleCount: 210,
      upDownRatio: 1.5,
      breadthPercent: 54.5,
      coveragePercent: 95.1,
      aboveEma20Percent: null,
      updatedAt: '2026-08-06T13:55:00.000Z',
      evaluatedAt: '2026-08-06T14:00:00.000Z',
      durationMs: 400,
      tradingDate: '2026-08-06',
      session: 'regular',
      source: 'alpaca-multi-snapshot',
      feed: 'delayed_sip',
      status: 'ready',
      universeDescription: 'หุ้นสหรัฐที่ระบบติดตาม',
    };
  }

  function disclosure(): HTMLDetailsElement | null {
    return [...container.querySelectorAll('details')]
      .find((item) => item.textContent?.includes('รายละเอียดข้อมูล')) as HTMLDetailsElement ?? null;
  }

  it('leads with coverage and freshness, in plain Thai', () => {
    render({ ...dashboardData('ready'), breadth: breadth() });
    const summary = disclosure()?.querySelector('summary');
    expect(summary?.textContent).toContain('ข้อมูลพร้อมใช้ 95.1%');
    expect(summary?.textContent).toContain('อัปเดตเมื่อ');
    expect(summary?.textContent).not.toContain('Failed');
    expect(summary?.textContent).not.toContain('Stale');
    expect(summary?.textContent).not.toContain('วินาที');
  });

  it('keeps every run detail, one tap away and closed by default', () => {
    render({ ...dashboardData('ready'), breadth: breadth() });
    const details = disclosure();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('ดึงข้อมูลไม่สำเร็จ 1');
    expect(details?.textContent).toContain('ข้อมูลเก่ากว่ากำหนด 210');
    expect(details?.textContent).toContain('0.4 วินาที');
    expect(details?.textContent).toContain('550');
    expect(details?.textContent).toContain('578');
  });
});
