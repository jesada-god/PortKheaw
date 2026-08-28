// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewDashboardData } from '@/src/lib/overview/types';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';

/**
 * The overview's portfolio line, over the states where a figure is MISSING.
 *
 * `DashboardClient.test.tsx` covers the states where the numbers are there. This
 * covers the ones where they are not, which is where the card has already been
 * wrong once: it showed today's move alone, and today's move is null the moment
 * any holding's quote arrives without a previous close — so on a US market
 * holiday the card read "ยังไม่มีข้อมูล (ยังไม่มีข้อมูล)" over a portfolio down
 * 80%, while the total return that says so was sitting unused in the same
 * summary object.
 *
 * A separate file rather than more cases in the existing one, because the two
 * ask different questions: that file is about what the card SAYS, this is about
 * what it does when it has nothing to say. Every case here is a combination the
 * `PortfolioSummary` type genuinely permits.
 */

const PRIVACY = { visible: true };

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/src/components/news/NewsFeed', () => ({ NewsFeed: () => <div /> }));
vi.mock('@/src/components/layout/Header', () => ({ default: () => <header /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/src/hooks/usePortfolioPrivacy', () => ({
  usePortfolioPrivacy: () => ({ visible: PRIVACY.visible, toggleVisibility: () => {} }),
}));

import { DashboardClient } from './DashboardClient';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A portfolio that lost money: the shape the holiday bug was reported on. */
function summary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    holdings: [],
    cashBalance: 0,
    marketValue: 184.44,
    costBasis: 930.72,
    realizedGain: 0,
    unrealizedGain: -746.28,
    totalValue: 184.44,
    equityMarketValue: 184.44,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: 930.72,
    netTransferredCapital: 0,
    totalGain: -746.28,
    totalGainPercent: -80.18,
    todayChange: null,
    todayChangePercent: null,
    todayChangeAsOf: null,
    todayChangeSource: null,
    optionPositions: [],
    hasMissingPrices: false,
    ...overrides,
  };
}

function data(
  portfolio: Partial<PortfolioSummary> | null,
  extra: Partial<OverviewDashboardData['portfolio']> = {},
): OverviewDashboardData {
  return {
    generatedAt: '2026-08-28T14:00:00.000Z',
    serviceStatus: {
      level: 'ready',
      label: 'ข้อมูลตลาดพร้อมใช้งาน',
      checkedAt: '2026-08-28T14:00:00.000Z',
      affected: [],
    },
    portfolio: {
      authenticated: true,
      portfolioCount: 1,
      totalPortfolioCount: 1,
      portfolioName: 'พอร์ตหลัก',
      summary: portfolio === null ? null : summary(portfolio),
      baseCurrency: 'USD',
      targetValueUsd: null,
      targetDate: null,
      valuedAt: null,
      todayExchangeDate: null,
      coverage: null,
      portfolios: [],
      ...extra,
    },
    usdThbRate: null,
    indices: [],
    industries: [],
    watchlist: [],
    breadth: null,
    industryData: {
      state: 'ready',
      classificationUpdatedAt: '2026-08-28T14:00:00.000Z',
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
  PRIVACY.visible = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function card(portfolio: Partial<PortfolioSummary> | null,
  extra: Partial<OverviewDashboardData['portfolio']> = {}): HTMLElement {
  act(() => root.render(<DashboardClient data={data(portfolio, extra)} />));
  return container.querySelector<HTMLElement>('[data-testid="overview-portfolio-summary"]')!;
}

/** The status marks the card drew, in order. */
function marks(node: HTMLElement): string[] {
  return [...node.querySelectorAll('[data-status]')].map((el) => el.getAttribute('data-status')!);
}

describe('when a figure cannot be computed', () => {
  /*
   * The reported bug, from the other side: the total return is the row that
   * survives, and it survives because it is gated on its OWN value rather than
   * on today's.
   */
  it('shows the total return AND says why today’s move is missing', () => {
    // The two figures fail independently, and the card no longer treats a
    // missing day figure as a reason to say nothing about it.
    const node = card({ todayChange: null, todayChangePercent: null });
    expect(node.textContent).toContain('กำไร/ขาดทุนรวม');
    expect(node.textContent).toContain('-80.18%');
    expect(node.textContent).toContain('วันนี้');
    expect(node.textContent).toContain('ยังไม่ได้ราคาปิดของบางรายการ');
  });

  /*
   * BOTH missing is a real state — a portfolio whose every quote failed. The
   * card must still render its total and its link rather than throwing or
   * printing an empty row, and it must not invent a status for either figure.
   */
  it('renders the card, with no return row and an explained day row, when both are missing', () => {
    const node = card({
      totalGain: null, totalGainPercent: null, todayChange: null, todayChangePercent: null,
    });
    expect(node).not.toBeNull();
    expect(node.textContent).toContain('มูลค่าพอร์ตรวม');
    // The return row is still simply absent: a total return that cannot be
    // computed has no session to explain it away, so there is nothing to say.
    expect(node.textContent).not.toContain('กำไร/ขาดทุนรวม');
    // The day row stays and explains itself.
    expect(node.textContent).toContain('วันนี้');
    expect(node.textContent).toContain('ยังไม่ได้ราคาปิดของบางรายการ');
    // No status mark for either: a colour is a reading, and there is none.
    expect(marks(node)).toEqual([]);
    for (const leak of ['undefined', 'null', 'NaN', 'ยังไม่มีข้อมูล']) {
      expect(node.textContent).not.toContain(leak);
    }
  });

  it('never prints a placeholder where a figure would have been', () => {
    // The rule the bug broke: a row is absent or real, never "no data" twice.
    const node = card({ todayChange: null, todayChangePercent: null });
    expect(node.textContent).not.toMatch(/ยังไม่มีข้อมูล \(ยังไม่มีข้อมูล\)/);
    expect(node.textContent).not.toContain('N/A');
  });

  /*
   * `portfolioTotalReturnPercent` returns null when the invested basis is zero
   * or below — a portfolio funded entirely by transfers — while `totalGain`
   * stays a real, signed number.
   *
   * This used to draw "-$746.28" beside ⚪: a loss on the screen and a mark
   * beside it saying there was no reading. The mark now falls back to the sign
   * of the amount, through the same mapper, so the two halves of the row agree.
   */
  it('reads the sign off the amount when only the percentage is missing', () => {
    const node = card({ totalGainPercent: null });
    expect(node.textContent).toContain('กำไร/ขาดทุนรวม');
    expect(marks(node)).toEqual(['bad']);
  });

  it('does the same for a gain, and for today’s row', () => {
    expect(marks(card({ totalGain: 512.4, totalGainPercent: null }))).toEqual(['good']);
    // Today's row takes the same fallback: its own percentage, then its amount.
    expect(marks(card({
      totalGain: null, totalGainPercent: null, todayChange: -8.25, todayChangePercent: null,
    }))).toEqual(['bad']);
  });

  /*
   * The fallback is coarser, never different: an amount of exactly zero is the
   * same 🟡 the percentage would have given, and a missing amount stays ⚪
   * rather than inventing a direction from nothing.
   */
  it('does not invent a direction when the amount is missing too', () => {
    expect(marks(card({ totalGain: 0, totalGainPercent: null }))).toEqual(['neutral']);
    expect(marks(card({ totalGain: null, totalGainPercent: null }))).toEqual([]);
  });
});

describe('while the balances are hidden', () => {
  /*
   * The mask exists for somebody looking over the reader's shoulder, so the
   * colour has to go with the number: a green mark beside •••• announces the
   * direction the mask was hiding.
   */
  it('masks every figure and paints no direction', () => {
    PRIVACY.visible = false;
    const node = card({ todayChange: -12.5, todayChangePercent: -1.2 });
    expect(node.textContent).toContain(SENSITIVE_VALUE_MASK);
    expect(node.textContent).not.toContain('-80.18');
    expect(node.textContent).not.toContain('184.44');
    expect(new Set(marks(node))).toEqual(new Set(['unknown']));
  });

  it('still names the rows, so the layout does not move when it is unmasked', () => {
    PRIVACY.visible = false;
    const node = card({ todayChange: -12.5, todayChangePercent: -1.2 });
    expect(node.textContent).toContain('กำไร/ขาดทุนรวม');
    expect(node.textContent).toContain('วันนี้');
  });
});

describe('a THB portfolio with no rate to convert with', () => {
  /*
   * HALF THE ROW IS KNOWN, AND THE ROW STAYS.
   *
   * `signedMoney` converts through `usdThbRate` and returns an em dash when
   * there is no rate. The percentage needs no rate — it is a ratio of two USD
   * figures and is just as true in either currency — so the amount is genuinely
   * unknown while the return is genuinely known.
   *
   * Hiding the row would withhold a return the reader can act on because a
   * conversion rate was missing, which is a worse answer than showing the half
   * that survived and marking the half that did not. The mark still comes off
   * the percentage, so it agrees with the half that is there.
   */
  it('prints the dash and keeps the percentage rather than hiding the row', () => {
    const node = card({}, { baseCurrency: 'THB' });
    expect(node.textContent).toContain('กำไร/ขาดทุนรวม');
    expect(node.textContent).toContain('— · -80.18%');
    expect(marks(node)).toEqual(['bad']);
  });

  it('keeps today’s row on the same terms', () => {
    const node = card({ todayChange: 3.2, todayChangePercent: 1.7 }, { baseCurrency: 'THB' });
    expect(node.textContent).toContain('วันนี้');
    expect(node.textContent).toContain('— · +1.70%');
    expect(marks(node)).toEqual(['bad', 'good']);
  });
});

describe('when some holdings could not be priced', () => {
  it('says the total is only what could be verified, and how much that was', () => {
    const node = card({ hasMissingPrices: true }, {
      coverage: { pricedAssets: 3, totalAssets: 5, verifiedValueUsd: 184.44 },
    } as Partial<OverviewDashboardData['portfolio']>);
    expect(node.textContent).toContain('มูลค่าที่ยืนยันได้');
    expect(node.textContent).not.toContain('มูลค่าพอร์ตรวม');
    expect(node.textContent).toContain('คำนวณได้ 3 จาก 5 สินทรัพย์');
  });

  /*
   * `coverage` is null whenever the server could not build one, and the card
   * still has to render — the counts fall back to zero rather than to
   * `undefined`, which is what would otherwise reach the screen.
   */
  it('renders the coverage line even with no coverage payload', () => {
    const node = card({ hasMissingPrices: true });
    expect(node.textContent).toContain('สินทรัพย์');
    expect(node.textContent).not.toContain('undefined');
  });
});

describe('the account with nothing in it', () => {
  it('invites a first portfolio instead of rendering an empty summary', () => {
    act(() => root.render(<DashboardClient data={data(null)} />));
    expect(container.querySelector('[data-testid="overview-portfolio-summary"]')).toBeNull();
    expect(container.textContent).toContain('เริ่มบันทึกพอร์ตแรกของคุณ');
  });
});
