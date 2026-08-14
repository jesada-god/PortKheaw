import { describe, expect, it } from 'vitest';
import {
  authorizeOptionSettlement,
  isOptionExpiryReached,
  optionMarketDate,
  optionSettlementSubject,
  planOptionSettlement,
  type OptionSettlementSubject,
} from './settlement';
import type { OptionPositionSummary } from './types';

/*
 * The rules that decide whether ใช้สิทธิ์ / หมดอายุ may happen at all.
 *
 * The case that made this module necessary is the first Put test below: a
 * production portfolio holding one ASTS $73 Put and no ASTS shares could record
 * an exercise, and $7,300 of cash appeared against shares that were never
 * delivered. The ledger's own constraint refused it eventually, but only with
 * "จำนวนหุ้นหรือสัญญาติดลบ" — so the money was decided by a database error
 * message rather than by a rule anybody could read.
 */

const CALL: OptionSettlementSubject = {
  underlyingSymbol: 'ASTS',
  optionKind: 'call',
  side: 'long',
  strikePrice: 73,
  multiplier: 100,
  expirationDate: '2026-08-28',
  openContracts: 2,
  underlyingPrice: 80,
};

const PUT: OptionSettlementSubject = { ...CALL, optionKind: 'put', underlyingPrice: 60 };

describe('option exercise settlement', () => {
  it('buys the underlying at the strike when the cash is there', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: CALL, contracts: 1, cashBalance: 10_000, underlyingShares: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.shares).toBe(100);
    expect(outcome.plan.underlyingDirection).toBe('receive');
    expect(outcome.plan.strikeValue).toBe(7_300);
    expect(outcome.plan.cashDelta).toBe(-7_300);
    expect(outcome.plan.cashAfter).toBe(2_700);
    expect(outcome.plan.underlyingSharesAfter).toBe(100);
    expect(outcome.plan.contractsRemaining).toBe(1);
  });

  it('refuses a Call exercise the portfolio cannot pay for', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: CALL, contracts: 1, cashBalance: 7_299.99, underlyingShares: 0,
    });
    expect(outcome).toEqual({
      ok: false,
      code: 'insufficient-cash',
      message: 'เงินสดในพอร์ตไม่เพียงพอสำหรับใช้สิทธิ์ Call นี้',
    });
  });

  it('sells the underlying at the strike when the shares are there', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 150,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.underlyingDirection).toBe('deliver');
    expect(outcome.plan.cashDelta).toBe(7_300);
    expect(outcome.plan.underlyingSharesAfter).toBe(50);
  });

  /* The regression this whole module exists for. */
  it('refuses a Put exercise with no shares to deliver, and invents no cash', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 0,
    });
    expect(outcome).toEqual({
      ok: false,
      code: 'insufficient-shares',
      message: 'มีหุ้น ASTS ไม่เพียงพอสำหรับใช้สิทธิ์ Put นี้',
    });
  });

  it('refuses a Put exercise that is short of shares by even a fraction of a lot', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: PUT, contracts: 2, cashBalance: 0, underlyingShares: 199,
    });
    expect(outcome.ok).toBe(false);
  });

  it('refuses more contracts than are open, and refuses none at all', () => {
    for (const contracts of [3, 0, -1, 1.5, Number.NaN]) {
      const outcome = planOptionSettlement({
        action: 'exercise', subject: CALL, contracts, cashBalance: 1_000_000, underlyingShares: 1_000,
      });
      expect(outcome.ok).toBe(false);
    }
    expect(planOptionSettlement({
      action: 'exercise', subject: CALL, contracts: 3, cashBalance: 1_000_000, underlyingShares: 0,
    })).toMatchObject({ code: 'contracts-exceed-open', message: 'จำนวนสัญญาต้องไม่เกินจำนวนที่ถืออยู่' });
  });

  it('allows a partial exercise and leaves the rest open', () => {
    const outcome = planOptionSettlement({
      action: 'exercise', subject: { ...CALL, openContracts: 5 }, contracts: 2, cashBalance: 20_000, underlyingShares: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.contractsRemaining).toBe(3);
    expect(outcome.plan.shares).toBe(200);
    expect(outcome.plan.cashDelta).toBe(-14_600);
  });

  it('sends a short position to Assignment rather than exercising it', () => {
    expect(planOptionSettlement({
      action: 'exercise', subject: { ...CALL, side: 'short' }, contracts: 1, cashBalance: 1_000_000, underlyingShares: 0,
    })).toMatchObject({ ok: false, code: 'short-side-exercise' });
  });
});

describe('option expiry settlement', () => {
  it('closes contracts and moves no money at all', () => {
    const outcome = planOptionSettlement({
      action: 'expired', subject: PUT, contracts: 2, cashBalance: 500, underlyingShares: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.cashDelta).toBe(0);
    expect(outcome.plan.cashAfter).toBe(500);
    expect(outcome.plan.shares).toBe(0);
    expect(outcome.plan.underlyingDirection).toBe('none');
    expect(outcome.plan.contractsRemaining).toBe(0);
  });

  it('warns when a long contract that still looks in the money is being let go', () => {
    const itm = planOptionSettlement({
      action: 'expired', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 0,
    });
    expect(itm.ok && itm.plan.inTheMoneyWarning).toBe(true);
    const otm = planOptionSettlement({
      action: 'expired', subject: { ...PUT, underlyingPrice: 90 }, contracts: 1, cashBalance: 0, underlyingShares: 0,
    });
    expect(otm.ok && otm.plan.inTheMoneyWarning).toBe(false);
    // Nothing is auto-exercised either way — the warning is the whole behaviour.
    expect(itm.ok && itm.plan.cashDelta).toBe(0);
  });

  it('refuses an expiry before the exchange has reached the expiration day', () => {
    expect(authorizeOptionSettlement({
      action: 'expired', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 0,
      marketDate: '2026-08-27',
    })).toEqual({ ok: false, code: 'not-expired', message: 'สัญญานี้ยังไม่ถึงวันหมดอายุ' });
  });

  it('allows it on the expiration day itself and after it', () => {
    for (const marketDate of ['2026-08-28', '2026-09-01']) {
      expect(authorizeOptionSettlement({
        action: 'expired', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 0, marketDate,
      }).ok).toBe(true);
    }
  });

  it('never gates an exercise on the expiration day — early exercise is legitimate', () => {
    expect(authorizeOptionSettlement({
      action: 'exercise', subject: PUT, contracts: 1, cashBalance: 0, underlyingShares: 200,
      marketDate: '2026-01-01',
    }).ok).toBe(true);
  });
});

describe('the calendar an expiry is judged by', () => {
  /*
   * Bangkok is eleven to twelve hours ahead of New York, so the reader's own day
   * turns over first. Judging by it would open "หมดอายุ" through the whole Thai
   * morning of the 28th — while the contract still has a full New York session
   * left to run.
   */
  it('reads the exchange day, not the reader’s', () => {
    // 2026-08-28 07:00 in Bangkok is 2026-08-27 20:00 in New York.
    const bangkokMorningOfExpiry = Date.parse('2026-08-28T00:00:00.000Z');
    expect(optionMarketDate(bangkokMorningOfExpiry)).toBe('2026-08-27');
    expect(isOptionExpiryReached('2026-08-28', optionMarketDate(bangkokMorningOfExpiry))).toBe(false);
    // 2026-08-28 21:00 in Bangkok is 2026-08-28 10:00 in New York: the day has come.
    expect(isOptionExpiryReached('2026-08-28', optionMarketDate(Date.parse('2026-08-28T14:00:00.000Z')))).toBe(true);
  });
});

describe('the subject read off a position', () => {
  it('copies the contract identity rather than letting a caller retype it', () => {
    const position = {
      key: 'ASTS260828P00073000',
      underlyingSymbol: 'ASTS',
      optionKind: 'put',
      side: 'long',
      strikePrice: 73,
      multiplier: 100,
      expirationDate: '2026-08-28',
      contracts: 1,
      underlyingPrice: 60,
    } as OptionPositionSummary;
    expect(optionSettlementSubject(position)).toEqual({
      underlyingSymbol: 'ASTS',
      optionKind: 'put',
      side: 'long',
      strikePrice: 73,
      multiplier: 100,
      expirationDate: '2026-08-28',
      openContracts: 1,
      underlyingPrice: 60,
    });
  });

  it('refuses a position with nothing left open', () => {
    expect(planOptionSettlement({
      action: 'expired', subject: { ...PUT, openContracts: 0 }, contracts: 1, cashBalance: 0, underlyingShares: 0,
    })).toMatchObject({ ok: false, code: 'position-closed' });
  });
});
