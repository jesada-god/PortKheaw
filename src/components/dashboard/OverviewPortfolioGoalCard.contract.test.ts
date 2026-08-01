import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const compact = read('src/components/dashboard/OverviewPortfolioGoalCard.tsx');
const dashboard = read('src/components/dashboard/DashboardClient.tsx');
const full = read('src/components/portfolio/PortfolioGoalCard.tsx');

describe('Overview compact portfolio goal card contract', () => {
  it('uses the same model, mood presentation, formatter, and mascot as Portfolio', () => {
    expect(dashboard).toContain('buildPortfolioGoalCardModel');
    expect(dashboard).toContain('<OverviewPortfolioGoalCard');
    expect(compact).toContain('portfolioGoalAppearance[model.today.mood]');
    expect(compact).toContain('<PortfolioGoalMascot compact mood={model.today.mood}');
    expect(full).toContain('<PortfolioGoalMascot mood={model.today.mood}');
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
});
