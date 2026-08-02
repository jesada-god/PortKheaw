import { describe, expect, it } from 'vitest';
import { entitlementFailure, READ_ONLY_PORTFOLIO_MESSAGE } from './entitlement-errors';
import {
  basicWritableStockPortfolioId,
  portfolioWriteBlock,
  type WritablePortfolioInput,
} from './portfolio-write-access';
import {
  canStartTrial,
  formatBangkokDateTime,
  formatTrialRemaining,
  resolveTrialState,
  trialFailureCode,
  trialFailureMessage,
} from './trial';
import type { SubscriptionSnapshot, SubscriptionStatus } from './subscription-types';

const NOW = '2026-08-03T12:00:00.000Z';

function snapshot(
  status: SubscriptionStatus,
  overrides: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    tier: 'basic',
    status,
    trialStartedAt: null,
    trialEndsAt: null,
    trialUsedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingPriceId: null,
    founderPromoApplied: false,
    createdAt: NOW,
    updatedAt: NOW,
    databaseNow: NOW,
    ...overrides,
  };
}

describe('resolveTrialState', () => {
  it('offers the trial only to a verified account that has never used one', () => {
    const eligible = resolveTrialState(snapshot('basic'), true);
    expect(eligible).toEqual({ kind: 'eligible' });
    expect(canStartTrial(eligible)).toBe(true);
  });

  it('blocks an unverified mailbox instead of offering the button', () => {
    const state = resolveTrialState(snapshot('basic'), false);
    expect(state).toEqual({ kind: 'email-unverified' });
    expect(canStartTrial(state)).toBe(false);
  });

  it('reports a live trial with the time left measured against the database clock', () => {
    const state = resolveTrialState(snapshot('trialing', {
      tier: 'elite',
      trialStartedAt: '2026-08-01T12:00:00.000Z',
      trialEndsAt: '2026-08-08T12:00:00.000Z',
      trialUsedAt: '2026-08-01T12:00:00.000Z',
    }), true);
    expect(state).toEqual({
      kind: 'trialing',
      endsAt: '2026-08-08T12:00:00.000Z',
      remainingMs: 5 * 24 * 60 * 60 * 1000,
    });
    expect(canStartTrial(state)).toBe(false);
  });

  it('falls to a used state the instant the trial reaches its end', () => {
    const atExpiry = snapshot('trialing', {
      tier: 'elite',
      trialEndsAt: NOW,
      trialUsedAt: '2026-07-27T12:00:00.000Z',
    });
    expect(resolveTrialState(atExpiry, true)).toEqual({ kind: 'used' });

    const justBefore = { ...atExpiry, trialEndsAt: '2026-08-03T12:00:00.001Z' };
    expect(resolveTrialState(justBefore, true).kind).toBe('trialing');

    const justAfter = { ...atExpiry, trialEndsAt: '2026-08-03T11:59:59.999Z' };
    expect(resolveTrialState(justAfter, true)).toEqual({ kind: 'used' });
  });

  it('never offers a second trial once one has been consumed', () => {
    const state = resolveTrialState(snapshot('expired', {
      trialUsedAt: '2026-07-01T00:00:00.000Z',
      trialEndsAt: '2026-07-08T00:00:00.000Z',
    }), true);
    expect(state).toEqual({ kind: 'used' });
    expect(canStartTrial(state)).toBe(false);
  });

  it.each(['pro', 'elite'] as const)('reports an active paid %s plan and hides the trial', (tier) => {
    const state = resolveTrialState(snapshot('active', {
      tier,
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    }), true);
    expect(state).toEqual({ kind: 'paid', tier });
    expect(canStartTrial(state)).toBe(false);
  });

  it('fails closed for an invalid or unreadable subscription', () => {
    expect(resolveTrialState(null, true)).toEqual({ kind: 'eligible' });
    // A trialing row with no end date cannot grant anything.
    expect(resolveTrialState(snapshot('trialing', { tier: 'elite' }), true)).toEqual({ kind: 'eligible' });
    // A lapsed paid period is not a paid plan.
    expect(resolveTrialState(snapshot('active', {
      tier: 'elite',
      currentPeriodEnd: '2020-01-01T00:00:00.000Z',
    }), true)).toEqual({ kind: 'eligible' });
    // An unparseable clock must not produce a live trial.
    expect(resolveTrialState(snapshot('trialing', {
      tier: 'elite',
      trialEndsAt: 'not-a-date',
      trialUsedAt: NOW,
    }), true)).toEqual({ kind: 'used' });
  });
});

describe('trial presentation', () => {
  it('describes the remaining window coarsely and never counts below zero', () => {
    expect(formatTrialRemaining(7 * 24 * 3_600_000)).toBe('7 วัน');
    expect(formatTrialRemaining(6 * 24 * 3_600_000 + 3 * 3_600_000)).toBe('6 วัน 3 ชั่วโมง');
    expect(formatTrialRemaining(2 * 3_600_000 + 30 * 60_000)).toBe('2 ชั่วโมง 30 นาที');
    expect(formatTrialRemaining(45 * 60_000)).toBe('45 นาที');
    expect(formatTrialRemaining(30_000)).toBe('ไม่ถึง 1 นาที');
    expect(formatTrialRemaining(0)).toBe('หมดอายุแล้ว');
    expect(formatTrialRemaining(-1)).toBe('หมดอายุแล้ว');
    expect(formatTrialRemaining(Number.NaN)).toBe('หมดอายุแล้ว');
  });

  it('formats the expiry in Bangkok time without depending on the host time zone', () => {
    // 12:00Z is 19:00 in Bangkok on the same day.
    expect(formatBangkokDateTime('2026-08-08T12:00:00.000Z')).toBe('8 ส.ค. 2569 เวลา 19:00 น.');
    // 18:00Z rolls over into the next Bangkok day, which is the case a naive
    // UTC render gets wrong.
    expect(formatBangkokDateTime('2026-08-08T18:00:00.000Z')).toBe('9 ส.ค. 2569 เวลา 01:00 น.');
    expect(formatBangkokDateTime('nonsense')).toBe('—');
  });

  it('maps database failures onto typed codes and Thai messages', () => {
    expect(trialFailureCode({ message: 'TRIAL_ALREADY_USED' })).toBe('TRIAL_ALREADY_USED');
    expect(trialFailureCode({ message: 'ERROR: EMAIL_NOT_VERIFIED (SQLSTATE P0001)' })).toBe('EMAIL_NOT_VERIFIED');
    expect(trialFailureCode({ message: 'PAID_SUBSCRIPTION_ACTIVE' })).toBe('PAID_SUBSCRIPTION_ACTIVE');
    expect(trialFailureCode({ message: 'TRIAL_ALREADY_ACTIVE' })).toBe('TRIAL_ALREADY_ACTIVE');
    expect(trialFailureCode({ message: 'SUBSCRIPTION_NOT_FOUND' })).toBe('SUBSCRIPTION_NOT_FOUND');
    // An unrecognised failure is never guessed at.
    expect(trialFailureCode({ message: 'connection reset' })).toBe('UNAVAILABLE');
    expect(trialFailureCode(null)).toBe('UNAVAILABLE');
    expect(trialFailureMessage('EMAIL_NOT_VERIFIED')).toContain('ยืนยันอีเมล');
    expect(trialFailureMessage('UNAVAILABLE')).toContain('ลองใหม่');
  });
});

describe('portfolio write access', () => {
  const portfolios: WritablePortfolioInput[] = [
    { id: 'legacy', type: 'LEGACY', archivedAt: null },
    { id: 'stock-oldest', type: 'STOCK', archivedAt: null },
    { id: 'stock-newer', type: 'STOCK', archivedAt: null },
    { id: 'options', type: 'OPTION', archivedAt: null },
  ];

  it('picks the oldest active stock portfolio, matching the database order', () => {
    expect(basicWritableStockPortfolioId(portfolios)).toBe('stock-oldest');
  });

  it('skips archived portfolios when choosing the writable one', () => {
    expect(basicWritableStockPortfolioId([
      { id: 'stock-oldest', type: 'STOCK', archivedAt: '2026-07-01T00:00:00.000Z' },
      { id: 'stock-newer', type: 'STOCK', archivedAt: null },
    ])).toBe('stock-newer');
    expect(basicWritableStockPortfolioId([{ id: 'legacy', type: 'LEGACY', archivedAt: null }])).toBeNull();
  });

  it('keeps everything writable above Basic', () => {
    for (const tier of ['pro', 'elite'] as const) {
      for (const portfolio of portfolios) {
        expect(portfolioWriteBlock(tier, portfolio, 'stock-oldest')).toBeNull();
      }
    }
  });

  it('locks options and every stock portfolio past the Basic allowance', () => {
    const writable = basicWritableStockPortfolioId(portfolios);
    expect(portfolioWriteBlock('basic', portfolios[0], writable)).toBeNull();
    expect(portfolioWriteBlock('basic', portfolios[1], writable)).toBeNull();
    expect(portfolioWriteBlock('basic', portfolios[2], writable)).toBe('read-only');
    expect(portfolioWriteBlock('basic', portfolios[3], writable)).toBe('upgrade');
  });
});

describe('entitlement failure mapping', () => {
  it('turns each database refusal into its own sentence', () => {
    expect(entitlementFailure({ message: 'READ_ONLY_SUBSCRIPTION:portfolio.stock.write' })).toEqual({
      code: 'READ_ONLY_SUBSCRIPTION',
      message: READ_ONLY_PORTFOLIO_MESSAGE,
    });
    expect(entitlementFailure({ message: 'UPGRADE_REQUIRED:portfolio.options.write' })).toEqual({
      code: 'UPGRADE_REQUIRED',
      message: 'พอร์ต Options แก้ไขได้เมื่อใช้ Pro ขึ้นไป ตอนนี้ยังเปิดดูข้อมูลเดิมได้ครบ',
    });
    expect(entitlementFailure({ message: 'UPGRADE_REQUIRED:portfolio.options.create' })).toEqual({
      code: 'UPGRADE_REQUIRED',
      message: 'พอร์ต Options ใช้ได้ใน Pro',
    });
    expect(entitlementFailure({ message: 'LIMIT_REACHED:STOCK:1' })).toEqual({
      code: 'LIMIT_REACHED',
      message: 'สร้างพอร์ตประเภทนี้ได้สูงสุด 1 พอร์ต',
    });
  });

  it('leaves unrelated database errors alone', () => {
    expect(entitlementFailure({ code: '23505', message: 'duplicate key value' })).toBeNull();
    expect(entitlementFailure(null)).toBeNull();
    expect(entitlementFailure({ message: 42 })).toBeNull();
  });
});
