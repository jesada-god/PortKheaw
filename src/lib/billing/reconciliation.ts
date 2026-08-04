/**
 * The daily comparison between what was billed and what is granted.
 *
 * Pure. It takes a snapshot of one account — its stored subscription and its
 * invoice history — and returns the disagreements. It writes nothing, fixes
 * nothing and calls nothing, which is deliberate twice over: it makes every rule
 * testable against a fixture, and it makes it impossible for this file to be the
 * thing that quietly changed somebody's access at three in the morning.
 *
 * The restraint is the design. An automatic repair that grants a tier is a
 * second, unsigned path to paid access. An automatic repair that withdraws one
 * takes away something somebody paid for on the strength of a query that might
 * be wrong. Both are worse than an operator reading a short list, so the output
 * here is a list.
 *
 * Every issue carries a stable `dedupeKey`, so a condition that persists for a
 * week is one row that has been seen seven times rather than seven rows.
 */

import type {
  BillingReconciliationIssueType,
  BillingReconciliationSeverity,
} from '@/src/types/database';

/** How far the stored period and the paid invoice's period may disagree. */
const PERIOD_TOLERANCE_MS = 36 * 60 * 60 * 1000;

/** The statuses that open a paid tier while the period is still running. */
const GRANTING_STATUSES = new Set(['active', 'past_due']);

export interface ReconciliationInvoice {
  /** Our uuid, never the provider's identifier. */
  invoiceRef: string;
  status: string;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface ReconciliationAccount {
  userId: string;
  tier: string;
  status: string;
  providerMode: string | null;
  collectionMethod: string | null;
  /** Presence only. The identifiers themselves never leave the database. */
  hasCustomer: boolean;
  hasSubscription: boolean;
  planKey: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  latestPaymentStatus: string | null;
  trialEndsAt: string | null;
  accessRevokedAt: string | null;
  accessRevokedReason: string | null;
  invoices: readonly ReconciliationInvoice[];
}

export interface ReconciliationIssue {
  dedupeKey: string;
  issueType: BillingReconciliationIssueType;
  severity: BillingReconciliationSeverity;
  userId: string | null;
  providerMode: string | null;
  /**
   * Sanitized by construction. Plan keys, statuses, timestamps and amounts are
   * product facts; no mailbox, display name or provider identifier is ever put
   * in here, because this object is read by an operator page and stored as-is.
   */
  detail: Record<string, string | number | boolean | null>;
}

function parsed(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function covers(invoice: ReconciliationInvoice, at: number): boolean {
  const start = parsed(invoice.periodStart);
  const end = parsed(invoice.periodEnd);
  if (end === null) return false;
  return (start === null || start <= at) && end > at;
}

/** Whether the stored row is currently opening a paid tier. */
export function grantsPaidAccess(account: ReconciliationAccount, at: number): boolean {
  if (account.status === 'trialing') {
    const trialEnd = parsed(account.trialEndsAt);
    return trialEnd !== null && trialEnd > at;
  }
  if (!GRANTING_STATUSES.has(account.status)) return false;
  const end = parsed(account.currentPeriodEnd);
  return end !== null && end > at;
}

/**
 * Every check, in one pass over one account.
 *
 * `now` is the database's clock, passed in rather than read, so a run is
 * reproducible and a drifting process clock cannot invent a lapsed period.
 */
export function reconcileAccount(
  account: ReconciliationAccount,
  now: string | number | Date,
): ReconciliationIssue[] {
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) return [];

  const issues: ReconciliationIssue[] = [];
  const mode = account.providerMode;
  const granted = grantsPaidAccess(account, at);
  const paidInvoices = account.invoices.filter(
    (invoice) => invoice.status === 'paid' || invoice.status === 'partially_refunded',
  );
  const coveringPaid = paidInvoices.find((invoice) => covers(invoice, at));

  const key = (suffix: string) => `${mode ?? 'unknown'}:${account.userId}:${suffix}`;

  // (1) Somebody paid for a period that is running, and holds nothing. This is
  // the failure that costs a customer, so it is the loudest one here.
  if (coveringPaid && !granted && account.status !== 'trialing') {
    issues.push({
      dedupeKey: key(`paid-no-tier:${coveringPaid.invoiceRef}`),
      issueType: 'paid_invoice_without_active_tier',
      severity: 'critical',
      userId: account.userId,
      providerMode: mode,
      detail: {
        invoiceRef: coveringPaid.invoiceRef,
        storedStatus: account.status,
        storedTier: account.tier,
        invoicePeriodEnd: coveringPaid.periodEnd,
        storedPeriodEnd: account.currentPeriodEnd,
      },
    });
  }

  // (2) A tier is open and no payment was ever confirmed for it. The trial is
  // excluded by construction: it is a grant, not a purchase.
  if (
    granted
    && account.status !== 'trialing'
    && paidInvoices.length === 0
    && account.latestPaymentStatus !== 'succeeded'
  ) {
    issues.push({
      dedupeKey: key('tier-no-payment'),
      issueType: 'active_tier_without_confirmed_payment',
      severity: 'critical',
      userId: account.userId,
      providerMode: mode,
      detail: {
        storedStatus: account.status,
        storedTier: account.tier,
        planKey: account.planKey,
        latestPaymentStatus: account.latestPaymentStatus,
        currentPeriodEnd: account.currentPeriodEnd,
      },
    });
  }

  // (3) The period the account holds is not the period that was paid for — or is
  // not a period at all.
  if (GRANTING_STATUSES.has(account.status)) {
    const storedEnd = parsed(account.currentPeriodEnd);
    const storedStart = parsed(account.currentPeriodStart);
    if (storedEnd === null) {
      issues.push({
        dedupeKey: key('period-missing'),
        issueType: 'tier_period_mismatch',
        severity: 'warning',
        userId: account.userId,
        providerMode: mode,
        detail: { storedStatus: account.status, reason: 'missing-period-end' },
      });
    } else if (storedStart !== null && storedStart >= storedEnd) {
      issues.push({
        dedupeKey: key('period-inverted'),
        issueType: 'tier_period_mismatch',
        severity: 'warning',
        userId: account.userId,
        providerMode: mode,
        detail: {
          storedStatus: account.status,
          reason: 'period-start-after-end',
          currentPeriodStart: account.currentPeriodStart,
          currentPeriodEnd: account.currentPeriodEnd,
        },
      });
    } else if (coveringPaid) {
      const invoiceEnd = parsed(coveringPaid.periodEnd);
      if (invoiceEnd !== null && Math.abs(invoiceEnd - storedEnd) > PERIOD_TOLERANCE_MS) {
        issues.push({
          dedupeKey: key(`period-drift:${coveringPaid.invoiceRef}`),
          issueType: 'tier_period_mismatch',
          severity: 'warning',
          userId: account.userId,
          providerMode: mode,
          detail: {
            invoiceRef: coveringPaid.invoiceRef,
            invoicePeriodEnd: coveringPaid.periodEnd,
            storedPeriodEnd: account.currentPeriodEnd,
            driftHours: Math.round(Math.abs(invoiceEnd - storedEnd) / 3_600_000),
          },
        });
      }
    }
  }

  // (4) A customer exists at the provider with nothing attached on our side.
  // Informational: it is the ordinary shape of a checkout somebody abandoned.
  if (account.hasCustomer && !account.hasSubscription && account.invoices.length === 0) {
    issues.push({
      dedupeKey: key('orphan-customer'),
      issueType: 'orphan_customer',
      severity: 'info',
      userId: account.userId,
      providerMode: mode,
      detail: { storedStatus: account.status },
    });
  }

  // (5) A subscription with no customer behind it cannot be billed or cancelled,
  // and cannot be matched to an incoming event by customer identity.
  if (account.hasSubscription && !account.hasCustomer) {
    issues.push({
      dedupeKey: key('orphan-subscription'),
      issueType: 'orphan_subscription',
      severity: 'warning',
      userId: account.userId,
      providerMode: mode,
      detail: { storedStatus: account.status, planKey: account.planKey },
    });
  }

  // (6) Access that should have ended and did not. Three sources, one issue
  // type, because the operator's next action is the same for all of them.
  if (granted && account.accessRevokedAt) {
    issues.push({
      dedupeKey: key('revoked-still-active'),
      issueType: 'revoked_access_still_active',
      severity: 'critical',
      userId: account.userId,
      providerMode: mode,
      detail: {
        source: 'revocation-flag',
        reason: account.accessRevokedReason,
        revokedAt: account.accessRevokedAt,
        storedStatus: account.status,
      },
    });
  }

  if (granted) {
    const withdrawn = account.invoices.find(
      (invoice) =>
        (invoice.status === 'refunded' || invoice.status === 'disputed')
        && covers(invoice, at),
    );
    if (withdrawn) {
      issues.push({
        dedupeKey: key(`withdrawn-invoice:${withdrawn.invoiceRef}`),
        issueType: 'revoked_access_still_active',
        severity: 'critical',
        userId: account.userId,
        providerMode: mode,
        detail: {
          source: 'invoice-status',
          invoiceRef: withdrawn.invoiceRef,
          invoiceStatus: withdrawn.status,
          storedStatus: account.status,
        },
      });
    }
  }

  return issues;
}

export interface DeadLetterDelivery {
  providerMode: string;
  providerEventId: string;
  eventType: string;
  userId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
}

/**
 * A dead-lettered delivery, as a reconciliation issue.
 *
 * The provider's event id is hashed into the dedupe key rather than put in the
 * detail: the key is never rendered, and the detail is. An operator needs to
 * know that a delivery of a given type failed permanently, not the identifier
 * that would let a browser replay it.
 */
export function deadLetterIssue(delivery: DeadLetterDelivery): ReconciliationIssue {
  return {
    dedupeKey: `${delivery.providerMode}:dead-letter:${delivery.providerEventId}`,
    issueType: 'dead_letter_event',
    severity: 'critical',
    userId: delivery.userId,
    providerMode: delivery.providerMode,
    detail: {
      eventType: delivery.eventType,
      attemptCount: delivery.attemptCount,
      lastErrorCode: delivery.lastErrorCode,
    },
  };
}
