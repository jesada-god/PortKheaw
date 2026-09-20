import type { AlertCondition, PriceAlert } from './types';

/**
 * WHAT `targetValue` IS MEASURED IN, PER CONDITION.
 *
 * A reader is never shown a price where a percentage belongs, and never a day
 * count as either. This is the one place the mapping is written down, so a
 * fifth condition cannot be added with a unit that only some call sites know
 * about — `Record<AlertCondition, …>` makes an omission a compile error.
 */
export const ALERT_UNIT: Readonly<Record<AlertCondition, 'price' | 'percent' | 'days'>> = {
  above: 'price',
  below: 'price',
  percent_change_up: 'percent',
  percent_change_down: 'percent',
  earnings: 'days',
};

/**
 * The Thai sentence one alert states.
 *
 * WHAT THE READER ASKED FOR, never what happened — the observed reading is
 * appended by whoever has one, because the two places that call this on a live
 * alert (the card on `/alerts` and the notification the sweep writes) disagree
 * about whether there is a reading to append at all.
 *
 * NOTE THE MATCHING LIVES IN SQL. `trigger_price_alert_service` decides every
 * comparison under a row lock in the same transaction that stamps the row, so
 * there is deliberately no `conditionMatches` beside this function: a second
 * evaluator in TypeScript is how the product ended up with two alert systems,
 * and one of them was wrong for a month without anybody noticing.
 */
export function describeCondition(condition: AlertCondition, target: number): string {
  if (condition === 'above') return `ราคามากกว่าหรือเท่ากับ ${target}`;
  if (condition === 'below') return `ราคาน้อยกว่าหรือเท่ากับ ${target}`;
  if (condition === 'percent_change_up') return `เพิ่มขึ้นอย่างน้อย ${target}%`;
  if (condition === 'percent_change_down') return `ลดลงอย่างน้อย ${target}%`;
  return `ประกาศผลประกอบการภายใน ${target} วัน`;
}

/**
 * How many ENABLED alerts each symbol carries, keyed by upper-case symbol.
 *
 * Pure, so the Watchlist badge can be counted from the list the Overview has
 * already read rather than from a second query against the same table.
 *
 * A DISABLED ALERT IS NOT COUNTED. It will not fire, and a badge that counted it
 * would tell a reader they are being watched when they are not. A symbol with no
 * enabled alerts is ABSENT rather than zero — the caller draws nothing for
 * either, but only an absent key is a statement this function is willing to
 * make.
 */
export function alertCountsBySymbol(
  alerts: readonly Pick<PriceAlert, 'symbol' | 'enabled'>[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const alert of alerts) {
    if (!alert.enabled) continue;
    const symbol = alert.symbol.trim().toUpperCase();
    if (!symbol) continue;
    counts[symbol] = (counts[symbol] ?? 0) + 1;
  }
  return counts;
}
