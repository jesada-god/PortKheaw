import { describe, expect, it } from 'vitest';
import {
  buildTransactionHistory,
  formatTransactionHistoryDay,
  limitTransactionHistory,
  transactionCashDirection,
  transactionDirectionToneClass,
} from './transaction-history';
import type { PortfolioRecord, PortfolioTransaction } from './types';

function transaction(
  id: string,
  type: PortfolioTransaction['type'],
  occurredAtTime: string,
  overrides: Partial<PortfolioTransaction> = {},
): PortfolioTransaction {
  return {
    id,
    portfolioId: 'p1',
    type,
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    occurredAt: occurredAtTime.slice(0, 10),
    occurredAtTime,
    note: null,
    createdAt: occurredAtTime,
    updatedAt: occurredAtTime,
    ...overrides,
  };
}

function portfolio(id: string, name: string, transactions: PortfolioTransaction[]): PortfolioRecord {
  return {
    id,
    name,
    type: 'STOCK',
    isLegacy: false,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
    targetValueUsd: null,
    targetDate: null,
    baseCurrency: 'USD',
    transactions: transactions.map((item) => ({ ...item, portfolioId: id })),
  };
}

const timezone = 'Asia/Bangkok';

describe('transaction history statement', () => {
  it('orders newest first and groups by the reader’s own calendar day', () => {
    const records = [portfolio('p1', 'หลัก', [
      transaction('old', 'deposit', '2026-08-01T03:00:00.000Z', { amount: '100' }),
      // 2026-08-02T18:00Z is already 2026-08-03 in Bangkok, so grouping by UTC
      // would file this under the wrong day.
      transaction('late', 'deposit', '2026-08-02T18:00:00.000Z', { amount: '50' }),
      transaction('mid', 'withdrawal', '2026-08-02T02:00:00.000Z', { amount: '20' }),
    ])];

    const days = buildTransactionHistory(records, timezone);
    expect(days.map((day) => day.dateKey)).toEqual(['2026-08-03', '2026-08-02', '2026-08-01']);
    expect(days.flatMap((day) => day.entries.map((entry) => entry.transaction.id)))
      .toEqual(['late', 'mid', 'old']);
  });

  it('scopes to one portfolio or spans them all', () => {
    const records = [
      portfolio('p1', 'หุ้น', [transaction('a', 'deposit', '2026-08-01T03:00:00.000Z', { amount: '100' })]),
      portfolio('p2', 'ออปชัน', [transaction('b', 'deposit', '2026-08-01T04:00:00.000Z', { amount: '200' })]),
    ];
    expect(buildTransactionHistory(records, timezone).flatMap((day) => day.entries).length).toBe(2);
    const scoped = buildTransactionHistory(records, timezone, 'p2').flatMap((day) => day.entries);
    expect(scoped.map((entry) => entry.transaction.id)).toEqual(['b']);
    expect(scoped[0].portfolioName).toBe('ออปชัน');
  });

  it('reads cash direction from the ledger, including reconciliation rows', () => {
    const records = [portfolio('p1', 'หลัก', [
      // What "ปรับยอดพอร์ต" writes: an ordinary deposit or withdrawal.
      transaction('up', 'deposit', '2026-08-01T03:00:00.000Z', { amount: '460', note: 'กระทบยอด' }),
      transaction('down', 'withdrawal', '2026-08-01T04:00:00.000Z', { amount: '100', note: 'ปรับยอดเริ่มต้น' }),
      transaction('flat', 'expired', '2026-08-01T05:00:00.000Z', {
        contractSymbol: 'AAPL260821C00200000',
        underlyingSymbol: 'AAPL',
        optionKind: 'call',
        optionSide: 'long',
        quantity: '1',
        price: '0',
        strikePrice: '200',
        expirationDate: '2026-08-21',
        multiplier: '100',
      }),
    ])];

    const entries = buildTransactionHistory(records, timezone).flatMap((day) => day.entries);
    const byId = Object.fromEntries(entries.map((entry) => [entry.transaction.id, entry]));
    expect(byId.up.direction).toBe('in');
    expect(byId.up.cashEffect).toBe(460);
    expect(byId.down.direction).toBe('out');
    expect(byId.down.cashEffect).toBe(-100);
    expect(byId.flat.direction).toBe('none');
    expect(byId.up.transaction.note).toBe('กระทบยอด');
  });

  it('maps direction to the shared money-in / money-out tokens', () => {
    expect(transactionCashDirection(12)).toBe('in');
    expect(transactionCashDirection(-12)).toBe('out');
    expect(transactionCashDirection(0)).toBe('none');
    expect(transactionCashDirection(Number.NaN)).toBe('none');
    expect(transactionDirectionToneClass('in', 'text-muted')).toBe('text-positive');
    expect(transactionDirectionToneClass('out', 'text-muted')).toBe('text-negative');
    expect(transactionDirectionToneClass('none', 'text-muted')).toBe('text-muted');
  });

  it('pages without splitting a day’s heading from its own rows', () => {
    const records = [portfolio('p1', 'หลัก', Array.from({ length: 7 }, (_, index) =>
      transaction(`t${index}`, 'deposit', `2026-08-0${(index % 3) + 1}T03:0${index}:00.000Z`, { amount: '10' })))];
    const days = buildTransactionHistory(records, timezone);

    const firstPage = limitTransactionHistory(days, 4);
    expect(firstPage.total).toBe(7);
    expect(firstPage.shown).toBe(4);
    expect(firstPage.days.flatMap((day) => day.entries).length).toBe(4);
    expect(firstPage.days.every((day) => day.entries.length > 0)).toBe(true);

    const everything = limitTransactionHistory(days, 25);
    expect(everything.shown).toBe(7);
    expect(everything.days.map((day) => day.dateKey)).toEqual(days.map((day) => day.dateKey));
  });

  it('renders a day heading from the already-local date without shifting it', () => {
    expect(formatTransactionHistoryDay('2026-08-03')).toContain('2569');
    expect(formatTransactionHistoryDay('2026-08-03')).toContain('3');
  });
});
