import type { PortfolioTransaction } from '../types';

/*
 * Where a transfer came from, or went to — in a sentence that still means
 * something after the other portfolio has been purged.
 *
 * The counterparty id is the good answer while both portfolios exist. Seven days
 * after a deletion the source is gone and that id is set to NULL, which is what
 * keeps the surviving portfolio's own ledger row legal and its holdings
 * unchanged. What remains is the name snapshot written at transfer time — and
 * that is the entire reason the snapshot exists. Without it this row would read
 * as shares that arrived from nowhere.
 */

export type TransferDirection = 'in' | 'out';

export interface TransferProvenance {
  direction: TransferDirection;
  /** The counterparty's name, snapshot or live. `null` when neither survives. */
  counterpartyName: string | null;
  /** True once the counterparty portfolio no longer exists. */
  counterpartyDeleted: boolean;
  label: string;
}

/**
 * `resolveLiveName` looks up a portfolio the reader still has. It is consulted
 * only when the row carries no snapshot, which is the case for cash transfers
 * written before snapshots existed.
 */
export function transferProvenance(
  transaction: PortfolioTransaction,
  resolveLiveName: (portfolioId: string) => string | null = () => null,
): TransferProvenance | null {
  if (transaction.type !== 'transfer_in' && transaction.type !== 'transfer_out') return null;
  const direction: TransferDirection = transaction.type === 'transfer_in' ? 'in' : 'out';

  const snapshot = direction === 'in'
    ? transaction.transferSourceName
    : transaction.transferDestinationName;
  const live = transaction.counterpartyPortfolioId
    ? resolveLiveName(transaction.counterpartyPortfolioId)
    : null;
  /*
   * A null counterparty id means the other portfolio was purged. It does not
   * mean "not found": a portfolio the reader has merely archived still has its
   * id here, and an id that resolves to no live name is one the reader owns but
   * this view was not given.
   */
  const counterpartyDeleted = transaction.counterpartyPortfolioId == null;
  const counterpartyName = live ?? snapshot ?? null;

  const verb = direction === 'in' ? 'รับโอนจาก' : 'โอนไปยัง';
  const label = counterpartyName === null
    ? `${verb}พอร์ตที่ลบแล้ว`
    : counterpartyDeleted
      ? `${verb} “${counterpartyName}” (พอร์ตที่ลบแล้ว)`
      : `${verb} “${counterpartyName}”`;

  return { direction, counterpartyName, counterpartyDeleted, label };
}
