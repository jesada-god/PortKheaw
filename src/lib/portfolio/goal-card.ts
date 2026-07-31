import { calculateGoalProgress } from './aggregate';
import type { PortfolioGoal, PortfolioSummary } from './types';

export type PortfolioGoalScope = 'selected' | 'aggregate';
export type PortfolioTodayMood =
  | 'strong-gain'
  | 'gain'
  | 'flat'
  | 'loss'
  | 'strong-loss'
  | 'severe-loss'
  | 'unavailable';

interface ReadyTodayState {
  kind: 'ready';
  mood: Exclude<PortfolioTodayMood, 'unavailable'>;
  amount: number;
  percent: number;
  message: string;
}

interface EmptyTodayState {
  kind: 'empty';
  mood: 'unavailable';
  title: 'ยังไม่มีสถานะพอร์ต';
  message: 'ลองเพิ่มสถานะพอร์ตและหุ้นหรือออปชันที่ถืออยู่สิ';
}

interface UnavailableTodayState {
  kind: 'unavailable';
  mood: 'unavailable';
  title: 'วันนี้ยังไม่มีข้อมูล';
  message: string;
}

export type PortfolioTodayState = ReadyTodayState | EmptyTodayState | UnavailableTodayState;

export interface PortfolioGoalCardModel {
  scope: PortfolioGoalScope;
  currentValue: number | null;
  goal: PortfolioGoal;
  progress: ReturnType<typeof calculateGoalProgress>;
  progressBarPercent: number;
  assetCount: number;
  activePortfolios: number;
  totalPortfolios: number;
  latestUpdatedAt: string | null;
  today: PortfolioTodayState;
}

export function portfolioAssetCount(summary: PortfolioSummary): number {
  return summary.holdings.length
    + summary.optionPositions.filter((position) => position.status === 'open').length;
}

export function latestPortfolioPriceTime(summary: PortfolioSummary): string | null {
  const values = [
    ...summary.holdings.map((holding) => holding.priceAsOf),
    ...summary.optionPositions
      .filter((position) => position.status === 'open')
      .map((position) => position.quoteAsOf),
  ].filter((value): value is string => Boolean(value));
  return values.sort().at(-1) ?? null;
}

export function portfolioTodayMood(percent: number): Exclude<PortfolioTodayMood, 'unavailable'> {
  if (percent > 3) return 'strong-gain';
  if (percent > 0.5) return 'gain';
  if (percent >= -0.5) return 'flat';
  if (percent >= -3) return 'loss';
  if (percent >= -8) return 'strong-loss';
  return 'severe-loss';
}

function moodMessage(mood: Exclude<PortfolioTodayMood, 'unavailable'>): string {
  switch (mood) {
    case 'strong-gain':
      return 'เย้! วันนี้พอร์ตยิ้มแล้ว~ 💚';
    case 'gain':
      return 'ดีเลย! เก็บกำไรทีละนิดก็เก่งมากแล้ว';
    case 'flat':
      return 'วันนี้เงียบ ๆ ก่อน รอดูโอกาสนะ';
    case 'loss':
      return 'ไม่เป็นไรน้า แค่ย่อตัวเอง';
    case 'strong-loss':
      return 'สู้ไปด้วยกันนะ อย่าเพิ่งหมดกำลังใจ';
    case 'severe-loss':
      return 'กอด ๆ ก่อน แล้วค่อยวางแผนใหม่ ❤️';
  }
}

function unavailableTodayReason(summary: PortfolioSummary): string {
  const openOptions = summary.optionPositions.filter((position) => position.status === 'open');
  const missingCurrentPrice = summary.holdings.some((holding) => holding.marketValue === null)
    || openOptions.some((position) => position.marketValue === null);
  if (missingCurrentPrice) {
    return 'ราคาปัจจุบันของบางสินทรัพย์ยังไม่พร้อม จึงยังคำนวณผลตอบแทนวันนี้ไม่ได้';
  }
  const missingPreviousClose = summary.holdings.some((holding) => holding.todayChange === null)
    || openOptions.some((position) => position.todayChange === null);
  if (missingPreviousClose) {
    return 'ยังไม่มีราคาปิดวันก่อนสำหรับบางสินทรัพย์';
  }
  return 'ข้อมูลผลตอบแทนวันนี้ยังไม่ครบพอสำหรับคำนวณสถานะ';
}

export function portfolioTodayState(summary: PortfolioSummary): PortfolioTodayState {
  if (portfolioAssetCount(summary) === 0) {
    return {
      kind: 'empty',
      mood: 'unavailable',
      title: 'ยังไม่มีสถานะพอร์ต',
      message: 'ลองเพิ่มสถานะพอร์ตและหุ้นหรือออปชันที่ถืออยู่สิ',
    };
  }
  if (
    summary.todayChange === null
    || summary.todayChangePercent === null
    || !Number.isFinite(summary.todayChange)
    || !Number.isFinite(summary.todayChangePercent)
  ) {
    return {
      kind: 'unavailable',
      mood: 'unavailable',
      title: 'วันนี้ยังไม่มีข้อมูล',
      message: unavailableTodayReason(summary),
    };
  }
  const mood = portfolioTodayMood(summary.todayChangePercent);
  return {
    kind: 'ready',
    mood,
    amount: summary.todayChange,
    percent: summary.todayChangePercent,
    message: moodMessage(mood),
  };
}

export function buildPortfolioGoalCardModel({
  scope,
  summary,
  goal,
  activePortfolios,
  totalPortfolios,
}: {
  scope: PortfolioGoalScope;
  summary: PortfolioSummary;
  goal: PortfolioGoal;
  activePortfolios: number;
  totalPortfolios: number;
}): PortfolioGoalCardModel {
  const progress = calculateGoalProgress(summary.totalValue, goal);
  return {
    scope,
    currentValue: summary.totalValue,
    goal,
    progress,
    progressBarPercent: Math.min(100, Math.max(0, progress.progressPercent ?? 0)),
    assetCount: portfolioAssetCount(summary),
    activePortfolios,
    totalPortfolios,
    latestUpdatedAt: latestPortfolioPriceTime(summary),
    today: portfolioTodayState(summary),
  };
}
