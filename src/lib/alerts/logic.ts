import type { Quote } from '@/src/lib/market-data/types';
import type { AlertCondition } from './types';

export interface AlertRule { condition: AlertCondition; targetValue: number }

export function shouldTriggerCrossing(wasMatching: boolean, matchesNow: boolean): boolean {
  return matchesNow && !wasMatching;
}

export function conditionMatches(rule: AlertRule, quote: Pick<Quote, 'price' | 'changePercent'>): boolean {
  if (!Number.isFinite(rule.targetValue) || rule.targetValue <= 0) return false;
  switch (rule.condition) {
    case 'above': return quote.price >= rule.targetValue;
    case 'below': return quote.price <= rule.targetValue;
    case 'percent_change_up': return quote.changePercent != null && quote.changePercent >= rule.targetValue;
    case 'percent_change_down': return quote.changePercent != null && quote.changePercent <= -rule.targetValue;
  }
}

export function cooldownElapsed(lastTriggeredAt: string | null, cooldownMinutes: number, now: Date): boolean {
  if (!lastTriggeredAt) return true;
  const last = new Date(lastTriggeredAt).getTime();
  return Number.isFinite(last) && now.getTime() >= last + cooldownMinutes * 60_000;
}

export function describeCondition(condition: AlertCondition, target: number): string {
  if (condition === 'above') return `ราคามากกว่าหรือเท่ากับ ${target}`;
  if (condition === 'below') return `ราคาน้อยกว่าหรือเท่ากับ ${target}`;
  if (condition === 'percent_change_up') return `เพิ่มขึ้นอย่างน้อย ${target}%`;
  return `ลดลงอย่างน้อย ${target}%`;
}
