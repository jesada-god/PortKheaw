import { fixed, fixedPercent, fixedToNumber, type Fixed } from '../money/fixed';
import type { GoalProgress, PortfolioGoal, PortfolioSummary } from './types';

function sum(values: number[]): number {
  return fixedToNumber(values.reduce<Fixed>((total, value) => total + fixed(value), 0n));
}

function sumNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : sum(values as number[]);
}

/** Combines already isolated portfolio results, never replaying transactions across portfolios. */
export function aggregatePortfolioSummaries(summaries: readonly PortfolioSummary[]): PortfolioSummary {
  const totalValue = sumNullable(summaries.map((summary) => summary.totalValue));
  const totalGain = sumNullable(summaries.map((summary) => summary.totalGain));
  const todayChange = sumNullable(summaries.map((summary) => summary.todayChange));
  const netDepositedCapital = sum(summaries.map((summary) => summary.netDepositedCapital));
  const previousValue = totalValue === null || todayChange === null ? null : fixed(totalValue) - fixed(todayChange);
  return {
    holdings: summaries.flatMap((summary) => summary.holdings),
    optionPositions: summaries.flatMap((summary) => summary.optionPositions),
    cashBalance: sum(summaries.map((summary) => summary.cashBalance)),
    marketValue: sumNullable(summaries.map((summary) => summary.marketValue)),
    equityMarketValue: sumNullable(summaries.map((summary) => summary.equityMarketValue)),
    optionsMarketValue: sumNullable(summaries.map((summary) => summary.optionsMarketValue)),
    costBasis: sum(summaries.map((summary) => summary.costBasis)),
    optionRemainingCost: sum(summaries.map((summary) => summary.optionRemainingCost)),
    realizedGain: sum(summaries.map((summary) => summary.realizedGain)),
    unrealizedGain: sumNullable(summaries.map((summary) => summary.unrealizedGain)),
    totalValue,
    netDepositedCapital,
    netTransferredCapital: sum(summaries.map((summary) => summary.netTransferredCapital)),
    totalGain,
    totalGainPercent: totalGain === null
      ? null
      : fixedToNumber(fixedPercent(fixed(totalGain), fixed(netDepositedCapital))),
    todayChange,
    todayChangePercent: todayChange === null || previousValue === null
      ? null
      : fixedToNumber(fixedPercent(fixed(todayChange), previousValue)),
    hasMissingPrices: summaries.some((summary) => summary.hasMissingPrices),
  };
}

export function calculateGoalProgress(currentValue: number | null, goal: PortfolioGoal): GoalProgress {
  if (goal.targetValueUsd === null) {
    return { progressPercent: null, remainingAmount: null, status: 'unset', reason: null };
  }
  if (!Number.isFinite(goal.targetValueUsd) || goal.targetValueUsd <= 0) {
    return {
      progressPercent: null,
      remainingAmount: null,
      status: 'unavailable',
      reason: 'เป้าหมายต้องมากกว่า 0',
    };
  }
  if (currentValue === null || !Number.isFinite(currentValue)) {
    return {
      progressPercent: null,
      remainingAmount: null,
      status: 'unavailable',
      reason: 'คำนวณไม่ได้เพราะยังมีสินทรัพย์ที่ไม่มีราคาปัจจุบัน',
    };
  }
  if (currentValue < 0) {
    return {
      progressPercent: 0,
      remainingAmount: goal.targetValueUsd - currentValue,
      status: 'negative',
      reason: 'มูลค่าพอร์ตติดลบ',
    };
  }
  const progressPercent = currentValue / goal.targetValueUsd * 100;
  return {
    progressPercent,
    remainingAmount: Math.max(0, goal.targetValueUsd - currentValue),
    status: progressPercent >= 100 ? 'reached' : 'tracking',
    reason: null,
  };
}
