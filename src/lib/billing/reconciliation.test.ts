import { describe, expect, it } from 'vitest';
import {
  deadLetterIssue,
  grantsPaidAccess,
  reconcileAccount,
  type ReconciliationAccount,
  type ReconciliationInvoice,
} from './reconciliation';

const NOW = '2026-08-05T00:00:00.000Z';
const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.parse(NOW) + offsetDays * day).toISOString();

function invoice(overrides: Partial<ReconciliationInvoice> = {}): ReconciliationInvoice {
  return {
    invoiceRef: 'inv-1',
    status: 'paid',
    amountPaidMinor: 799_000,
    amountRefundedMinor: 0,
    paidAt: at(-10),
    periodStart: at(-10),
    periodEnd: at(355),
    ...overrides,
  };
}

function account(overrides: Partial<ReconciliationAccount> = {}): ReconciliationAccount {
  return {
    userId: 'user-1',
    tier: 'elite',
    status: 'active',
    providerMode: 'live',
    collectionMethod: 'charge_automatically',
    hasCustomer: true,
    hasSubscription: true,
    planKey: 'elite_annual',
    currentPeriodStart: at(-10),
    currentPeriodEnd: at(355),
    cancelAtPeriodEnd: false,
    latestPaymentStatus: 'succeeded',
    trialEndsAt: null,
    accessRevokedAt: null,
    accessRevokedReason: null,
    invoices: [invoice()],
    ...overrides,
  };
}

function types(issues: ReturnType<typeof reconcileAccount>): string[] {
  return issues.map((issue) => issue.issueType);
}

describe('a healthy account', () => {
  it('reports nothing', () => {
    expect(reconcileAccount(account(), NOW)).toEqual([]);
  });
});

describe('paid but not granted', () => {
  it('is critical — somebody paid and holds nothing', () => {
    const issues = reconcileAccount(
      account({ status: 'expired', tier: 'basic' }),
      NOW,
    );
    expect(types(issues)).toContain('paid_invoice_without_active_tier');
    expect(issues[0].severity).toBe('critical');
  });

  it('names the invoice in the dedupe key, so one purchase is one row', () => {
    const issues = reconcileAccount(account({ status: 'expired' }), NOW);
    const found = issues.find((issue) => issue.issueType === 'paid_invoice_without_active_tier');
    expect(found?.dedupeKey).toContain('inv-1');
    expect(found?.dedupeKey).toContain('user-1');
  });

  it('does not fire for a lapsed invoice whose period is over', () => {
    const issues = reconcileAccount(
      account({
        status: 'expired',
        invoices: [invoice({ periodStart: at(-400), periodEnd: at(-40) })],
      }),
      NOW,
    );
    expect(types(issues)).not.toContain('paid_invoice_without_active_tier');
  });
});

describe('granted without a confirmed payment', () => {
  it('is critical', () => {
    const issues = reconcileAccount(
      account({ invoices: [], latestPaymentStatus: null }),
      NOW,
    );
    expect(types(issues)).toContain('active_tier_without_confirmed_payment');
  });

  it('excludes a running trial, which is a grant rather than a purchase', () => {
    const issues = reconcileAccount(
      account({
        status: 'trialing',
        trialEndsAt: at(3),
        invoices: [],
        latestPaymentStatus: null,
        hasCustomer: false,
        hasSubscription: false,
      }),
      NOW,
    );
    expect(types(issues)).not.toContain('active_tier_without_confirmed_payment');
  });
});

describe('period mismatches', () => {
  it('flags a granting status with no period at all', () => {
    const issues = reconcileAccount(
      account({ currentPeriodEnd: null, invoices: [] }),
      NOW,
    );
    expect(types(issues)).toContain('tier_period_mismatch');
  });

  it('flags a period that ends before it starts', () => {
    const issues = reconcileAccount(
      account({ currentPeriodStart: at(10), currentPeriodEnd: at(5), invoices: [] }),
      NOW,
    );
    expect(types(issues)).toContain('tier_period_mismatch');
  });

  it('flags a stored period that drifted from the paid one', () => {
    const issues = reconcileAccount(
      account({ currentPeriodEnd: at(200) }),
      NOW,
    );
    expect(types(issues)).toContain('tier_period_mismatch');
  });

  it('tolerates a small difference, which renewals routinely produce', () => {
    const issues = reconcileAccount(
      account({ currentPeriodEnd: new Date(Date.parse(at(355)) + 3_600_000).toISOString() }),
      NOW,
    );
    expect(types(issues)).not.toContain('tier_period_mismatch');
  });
});

describe('orphans', () => {
  it('reports a customer with nothing attached as information, not an alarm', () => {
    const issues = reconcileAccount(
      account({
        status: 'basic',
        tier: 'basic',
        hasSubscription: false,
        currentPeriodEnd: null,
        latestPaymentStatus: null,
        invoices: [],
      }),
      NOW,
    );
    const found = issues.find((issue) => issue.issueType === 'orphan_customer');
    expect(found?.severity).toBe('info');
  });

  it('reports a subscription with no customer behind it', () => {
    const issues = reconcileAccount(account({ hasCustomer: false }), NOW);
    expect(types(issues)).toContain('orphan_subscription');
  });
});

describe('access that should have ended', () => {
  it('flags a revocation flag that did not take', () => {
    const issues = reconcileAccount(account({ accessRevokedAt: at(-1), accessRevokedReason: 'refund' }), NOW);
    const found = issues.find((issue) => issue.issueType === 'revoked_access_still_active');
    expect(found?.severity).toBe('critical');
    expect(found?.detail.source).toBe('revocation-flag');
  });

  it('flags a refunded invoice whose period is still granting', () => {
    const issues = reconcileAccount(
      account({ invoices: [invoice({ status: 'refunded' })] }),
      NOW,
    );
    const found = issues.find(
      (issue) => issue.issueType === 'revoked_access_still_active' && issue.detail.source === 'invoice-status',
    );
    expect(found).toBeDefined();
  });

  it('flags a disputed invoice the same way', () => {
    const issues = reconcileAccount(
      account({ invoices: [invoice({ status: 'disputed' })] }),
      NOW,
    );
    expect(types(issues)).toContain('revoked_access_still_active');
  });
});

describe('sanitization', () => {
  it('puts nothing personal or provider-shaped in a detail object', () => {
    const issues = reconcileAccount(account({ status: 'expired' }), NOW);
    for (const issue of issues) {
      const serialized = JSON.stringify(issue.detail);
      expect(serialized).not.toMatch(/cus_|sub_|in_|@/);
    }
  });

  it('keeps the provider event id out of a dead letter’s visible detail', () => {
    const issue = deadLetterIssue({
      providerMode: 'live',
      providerEventId: 'evt_secret_123',
      eventType: 'invoice.paid',
      userId: 'user-1',
      attemptCount: 8,
      lastErrorCode: 'apply_failed',
    });
    expect(JSON.stringify(issue.detail)).not.toContain('evt_secret_123');
    // The key is never rendered; it exists only to deduplicate.
    expect(issue.dedupeKey).toContain('evt_secret_123');
  });
});

describe('grantsPaidAccess', () => {
  it('honours a running trial and a live paid period', () => {
    expect(grantsPaidAccess(account({ status: 'trialing', trialEndsAt: at(3) }), Date.parse(NOW))).toBe(true);
    expect(grantsPaidAccess(account(), Date.parse(NOW))).toBe(true);
  });

  it('refuses a lapsed period and an expired trial', () => {
    expect(grantsPaidAccess(account({ currentPeriodEnd: at(-1) }), Date.parse(NOW))).toBe(false);
    expect(grantsPaidAccess(
      account({ status: 'trialing', trialEndsAt: at(-1) }),
      Date.parse(NOW),
    )).toBe(false);
  });

  it('keeps past_due granting until the paid period ends', () => {
    expect(grantsPaidAccess(account({ status: 'past_due' }), Date.parse(NOW))).toBe(true);
  });
});
