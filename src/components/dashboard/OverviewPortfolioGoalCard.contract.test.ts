import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const compact = read('src/components/dashboard/OverviewPortfolioGoalCard.tsx');
const dashboard = read('src/components/dashboard/DashboardClient.tsx');
const full = read('src/components/portfolio/PortfolioGoalCard.tsx');

/*
 * THE OVERVIEW NO LONGER MOUNTS THIS CARD, and that is deliberate.
 *
 * Phase 1 condensed the overview's portfolio block to a single line — total,
 * today's move, a status and a link — so the goal card, the scope selector and
 * the cash/equity/options strip all moved to `/portfolio`, which is a page built
 * for that reading. The two assertions that pinned `<OverviewPortfolioGoalCard`
 * and `buildPortfolioGoalCardModel` into `DashboardClient.tsx` went with them;
 * `overview.contract.test.ts` now asserts the opposite, on purpose.
 *
 * The COMPONENT is still here, and so is every guarantee below it, because the
 * compact card is what `PortfolioGoalMascot.test.tsx` and
 * `PortfolioGoalSelector.test.tsx` render their fixtures through — it is the
 * only compact rendering of the goal model in the tree, and those two suites are
 * about the mascot and the selector rather than about the overview. Its parity
 * with the full card is therefore still worth holding.
 */
describe('Overview compact portfolio goal card contract', () => {
  it('uses the same model, mood presentation, formatter, and mascot as Portfolio', () => {
    expect(compact).toContain('portfolioGoalAppearance[model.mascot.mood]');
    expect(compact).toContain('<PortfolioGoalMascot compact state={model.mascot}');
    expect(full).toContain('<PortfolioGoalMascot state={model.mascot}');
    expect(compact).toContain('data-mood-source={model.mascot.source}');
    expect(compact).toContain("data-special-event={model.mascot.specialEvent ?? 'none'}");
    expect(compact).toContain('formatPortfolioGoalTime(model.latestUpdatedAt)');
  });

  it('shows goal progress, values, counts, update time, and Today P/L only', () => {
    for (const label of [
      'เป้าหมายพอร์ต',
      'ยอดปัจจุบัน',
      'ยอดเป้าหมาย',
      'ยังไม่ได้ตั้งเป้าหมาย',
      'Today P/L',
      'พอร์ตใช้งาน',
      'สินทรัพย์',
      'อัปเดตล่าสุด',
    ]) expect(compact).toContain(label);
    expect(compact).toContain('role="progressbar"');
    expect(compact).not.toContain('Total P/L');
  });

  it('keeps the mascot subordinate and the card overflow-safe at all target widths', () => {
    expect(compact).toContain('grid-cols-[minmax(0,1fr)_72px]');
    expect(compact).toContain('sm:grid-cols-[minmax(0,1fr)_88px]');
    expect(compact).toContain('lg:grid-cols-[minmax(0,1fr)_104px]');
    expect(compact).toContain('min-w-0 overflow-hidden');
  });

  it('uses fresh server portfolio data without a stale local-state snapshot', () => {
    expect(dashboard).toContain('viewState.source === data ? viewState.value : data');
    expect(dashboard).toContain('current.source === data ? current.value : data');
  });
});
