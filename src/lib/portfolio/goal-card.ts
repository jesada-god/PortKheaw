import { calculateGoalProgress } from './aggregate';
import type { PortfolioGoal, PortfolioSummary } from './types';

export type PortfolioGoalScope = 'selected' | 'aggregate';
export type PortfolioMascotMood =
  | 'strongGain'
  | 'gain'
  | 'neutral'
  | 'smallLoss'
  | 'loss'
  | 'heavyLoss';
export type PortfolioMascotSource = 'today' | 'total' | 'none';
export type PortfolioMascotSpecialEvent = 'lossOver50' | 'gainOver50' | 'gainOver100';
export type PortfolioTodayMood = PortfolioMascotMood | 'unavailable';

export interface PortfolioMascotState {
  mood: PortfolioMascotMood;
  source: PortfolioMascotSource;
  specialEvent: PortfolioMascotSpecialEvent | null;
  percent: number | null;
  message: string;
}

interface ReadyTodayState {
  kind: 'ready';
  mood: PortfolioMascotMood;
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
  mascot: PortfolioMascotState;
}

export function formatPortfolioGoalTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(parsed);
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

export function portfolioTodayMood(percent: number): PortfolioMascotMood {
  if (percent >= 3) return 'strongGain';
  if (percent >= 0.5) return 'gain';
  if (percent > -0.5) return 'neutral';
  if (percent > -3) return 'smallLoss';
  if (percent > -7) return 'loss';
  return 'heavyLoss';
}

function todayMoodMessage(mood: PortfolioMascotMood): string {
  switch (mood) {
    case 'strongGain':
      return 'วาสนาผู้ใดหนอออ!';
    case 'gain':
      return 'ยกโลว์โชว์เหนือ';
    case 'neutral':
      return 'รอเจ้าตื่น';
    case 'smallLoss':
      return 'แค่ Pullback (มั้ง?)';
    case 'loss':
      return 'จะวูบของแทร่';
    case 'heavyLoss':
      return 'สู้ชีวิตแต่โดนกราฟสู้กลับ!';
  }
}

function totalMoodMessage(mood: PortfolioMascotMood): string {
  switch (mood) {
    case 'strongGain':
      return 'วาสนาผู้ใดหนอออ!';
    case 'gain':
      return 'ยกโลว์โชว์เหนือ';
    case 'neutral':
      return 'รอเจ้าตื่น';
    case 'smallLoss':
      return 'แค่ Pullback (มั้ง?)';
    case 'loss':
      return 'จะวูบของแทร่';
    case 'heavyLoss':
      return 'สู้ชีวิตแต่โดนกราฟสู้กลับ!';
  }
}

export function resolvePortfolioMascotState({
  todayReturnPct,
  totalReturnPct,
  todayDataComplete,
}: {
  todayReturnPct: number | null;
  totalReturnPct: number | null;
  todayDataComplete: boolean;
}): PortfolioMascotState {
  const finiteTotal = totalReturnPct !== null && Number.isFinite(totalReturnPct)
    ? totalReturnPct
    : null;

  if (finiteTotal !== null && finiteTotal <= -50) {
    return {
      mood: 'heavyLoss',
      source: 'total',
      specialEvent: 'lossOver50',
      percent: finiteTotal,
      message: 'วัดไหนข้าวอร่อยบอกด้วย',
    };
  }
  if (finiteTotal !== null && finiteTotal >= 100) {
    return {
      mood: 'strongGain',
      source: 'total',
      specialEvent: 'gainOver100',
      percent: finiteTotal,
      message: 'โอ๊ย! รวยไม่ไหวแล้ววว',
    };
  }
  if (finiteTotal !== null && finiteTotal >= 50) {
    return {
      mood: 'strongGain',
      source: 'total',
      specialEvent: 'gainOver50',
      percent: finiteTotal,
      message: 'มื้อนี้ชาบูต้องเข้าแล้วมะ!',
    };
  }

  if (todayDataComplete && todayReturnPct !== null && Number.isFinite(todayReturnPct)) {
    const mood = portfolioTodayMood(todayReturnPct);
    return {
      mood,
      source: 'today',
      specialEvent: null,
      percent: todayReturnPct,
      message: todayMoodMessage(mood),
    };
  }

  if (finiteTotal !== null) {
    const mood = portfolioTodayMood(finiteTotal);
    return {
      mood,
      source: 'total',
      specialEvent: null,
      percent: finiteTotal,
      message: totalMoodMessage(mood),
    };
  }

  return {
    mood: 'neutral',
    source: 'none',
    specialEvent: null,
    percent: null,
    message: 'รอเจ้าตื่น',
  };
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
    message: todayMoodMessage(mood),
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
  const today = portfolioTodayState(summary);
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
    today,
    mascot: resolvePortfolioMascotState({
      todayReturnPct: summary.todayChangePercent,
      totalReturnPct: summary.totalGainPercent,
      todayDataComplete: today.kind === 'ready',
    }),
  };
}
