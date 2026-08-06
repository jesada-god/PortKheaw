import { describe, expect, it } from 'vitest';
import type { PortfolioTransaction } from '../types';
import { transferProvenance } from './provenance';

/*
 * The case that matters is the last one: seven days after a source portfolio is
 * deleted it is purged, its id is cleared from the surviving destination's rows,
 * and the only thing left saying where those shares came from is the name
 * written into the row at transfer time.
 */

function transfer(overrides: Partial<PortfolioTransaction> & { type: PortfolioTransaction['type'] }): PortfolioTransaction {
  return {
    id: 'row-1',
    portfolioId: 'destination',
    symbol: 'AAPL',
    quantity: '6',
    price: '150',
    amount: null,
    originalCurrency: 'USD',
    occurredAt: '2026-03-01',
    occurredAtTime: '2026-03-01T05:00:00.000Z',
    note: null,
    createdAt: '2026-03-01T05:00:00.000Z',
    updatedAt: '2026-03-01T05:00:00.000Z',
    transferId: 'leg-1',
    transferGroupId: 'group-1',
    ...overrides,
  };
}

describe('reading where a transfer came from', () => {
  it('says nothing about a row that is not a transfer', () => {
    expect(transferProvenance(transfer({ type: 'acquisition', transferId: null, transferGroupId: null })))
      .toBeNull();
  });

  it('names the live source portfolio on an incoming transfer', () => {
    const result = transferProvenance(
      transfer({ type: 'transfer_in', counterpartyPortfolioId: 'source', transferSourceName: 'ชื่อเก่า' }),
      (id) => id === 'source' ? 'พอร์ตต้นทาง' : null,
    );
    // The live name wins, so renaming a portfolio updates what its past
    // transfers say about it.
    expect(result?.label).toBe('รับโอนจาก “พอร์ตต้นทาง”');
    expect(result?.counterpartyDeleted).toBe(false);
  });

  it('names the live destination on an outgoing transfer', () => {
    const result = transferProvenance(
      transfer({ type: 'transfer_out', portfolioId: 'source', counterpartyPortfolioId: 'destination' }),
      () => 'พอร์ตปลายทาง',
    );
    expect(result?.label).toBe('โอนไปยัง “พอร์ตปลายทาง”');
  });

  it('falls back to the snapshot when the counterparty has been purged', () => {
    const result = transferProvenance(
      transfer({
        type: 'transfer_in',
        counterpartyPortfolioId: null,
        transferSourceName: 'พอร์ตที่ถูกลบไปแล้ว',
      }),
    );
    expect(result?.label).toBe('รับโอนจาก “พอร์ตที่ถูกลบไปแล้ว” (พอร์ตที่ลบแล้ว)');
    expect(result?.counterpartyDeleted).toBe(true);
    expect(result?.counterpartyName).toBe('พอร์ตที่ถูกลบไปแล้ว');
  });

  it('still reads as a sentence when there is no snapshot either', () => {
    // A cash transfer written before snapshots existed, whose counterparty has
    // since been purged. There is nothing left to name, and the row must not
    // read as shares arriving from nowhere.
    const result = transferProvenance(
      transfer({ type: 'transfer_in', counterpartyPortfolioId: null, transferSourceName: null }),
    );
    expect(result?.label).toBe('รับโอนจากพอร์ตที่ลบแล้ว');
    expect(result?.counterpartyName).toBeNull();
  });

  it('does not call an archived counterparty deleted just because this view lacks it', () => {
    const result = transferProvenance(
      transfer({ type: 'transfer_in', counterpartyPortfolioId: 'source', transferSourceName: 'พอร์ตเดิม' }),
      () => null,
    );
    // The id is still there, so the portfolio still exists; only this view was
    // not given it. The snapshot names it and it is not reported as deleted.
    expect(result?.counterpartyDeleted).toBe(false);
    expect(result?.label).toBe('รับโอนจาก “พอร์ตเดิม”');
  });
});
