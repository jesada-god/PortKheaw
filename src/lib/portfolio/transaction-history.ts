import { cashEffectForTransaction } from './cash-preview';
import { formatDateTimeLocal } from './transaction-datetime';
import type { PortfolioRecord, PortfolioTransaction } from './types';

/*
 * The statement view of the Transaction Ledger.
 *
 * It reads the same rows the portfolio itself is calculated from — there is no
 * second table and no separate history record. All this does is order them,
 * cut them into days in the reader's own time zone, and say which way the cash
 * went.
 */

export type TransactionCashDirection = 'in' | 'out' | 'none';

export interface TransactionHistoryEntry {
  transaction: PortfolioTransaction;
  portfolioName: string;
  /** Signed cash movement in canonical USD. */
  cashEffect: number;
  direction: TransactionCashDirection;
  occurredAtIso: string;
}

export interface TransactionHistoryDay {
  /** `YYYY-MM-DD` in the reader's time zone, not UTC. */
  dateKey: string;
  entries: TransactionHistoryEntry[];
}

export function transactionCashDirection(cashEffect: number): TransactionCashDirection {
  if (!Number.isFinite(cashEffect) || cashEffect === 0) return 'none';
  return cashEffect > 0 ? 'in' : 'out';
}

export function transactionDirectionToneClass(
  direction: TransactionCashDirection,
  neutralClass: string,
): string {
  if (direction === 'in') return 'text-positive';
  if (direction === 'out') return 'text-negative';
  return neutralClass;
}

export function buildTransactionHistory(
  portfolios: readonly PortfolioRecord[],
  timezone: string,
  portfolioId: 'all' | string = 'all',
): TransactionHistoryDay[] {
  const entries: TransactionHistoryEntry[] = [];
  for (const portfolio of portfolios) {
    if (portfolioId !== 'all' && portfolio.id !== portfolioId) continue;
    for (const transaction of portfolio.transactions) {
      const cashEffect = cashEffectForTransaction(transaction);
      entries.push({
        transaction,
        portfolioName: portfolio.name,
        cashEffect,
        direction: transactionCashDirection(cashEffect),
        occurredAtIso: transaction.occurredAtTime ?? transaction.occurredAt,
      });
    }
  }

  entries.sort((left, right) => {
    const difference = Date.parse(right.occurredAtIso) - Date.parse(left.occurredAtIso);
    if (difference !== 0) return difference;
    // A stable tiebreak keeps two rows stamped at the same minute in the same
    // order on every render, and on the server and the client alike.
    return right.transaction.createdAt.localeCompare(left.transaction.createdAt)
      || right.transaction.id.localeCompare(left.transaction.id);
  });

  const days: TransactionHistoryDay[] = [];
  for (const entry of entries) {
    const dateKey = formatDateTimeLocal(entry.occurredAtIso, timezone).slice(0, 10)
      || entry.occurredAtIso.slice(0, 10);
    const last = days.at(-1);
    if (last && last.dateKey === dateKey) last.entries.push(entry);
    else days.push({ dateKey, entries: [entry] });
  }
  return days;
}

/** Takes the first `count` entries while keeping whole day groups intact. */
export function limitTransactionHistory(
  days: readonly TransactionHistoryDay[],
  count: number,
): { days: TransactionHistoryDay[]; total: number; shown: number } {
  const total = days.reduce((sum, day) => sum + day.entries.length, 0);
  const limited: TransactionHistoryDay[] = [];
  let shown = 0;
  for (const day of days) {
    if (shown >= count) break;
    const entries = day.entries.slice(0, count - shown);
    shown += entries.length;
    limited.push({ dateKey: day.dateKey, entries });
  }
  return { days: limited, total, shown };
}

/**
 * `dateKey` is already a calendar date in the reader's zone, so it is rendered
 * in UTC — converting it a second time would slide the heading by a day.
 */
export function formatTransactionHistoryDay(dateKey: string): string {
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return dateKey;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'full', timeZone: 'UTC' }).format(parsed);
}
