'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getBillingAvailability, getBillingConfig } from '@/src/lib/billing/billing-server';
import {
  cancelPendingPromptPayPayment,
  readBillingCustomerId,
  readBillingSnapshot,
  readPendingPromptPayIdentity,
  readPendingPromptPayPayment,
  readPromptPaySubscriptionIdentity,
  recordPendingPromptPayPayment,
  type PendingPaymentOutcome,
} from '@/src/lib/billing/billing-repository';
import { holdsLiveSubscription, holdsReusablePromptPaySubscription } from '@/src/lib/billing/billing-summary';
import type { BillingPaymentMethod } from '@/src/lib/billing/billing-payment-method';
import { billingPlan, isBillingPlanKey } from '@/src/lib/billing/billing-plans';
import { pendingPromptPayIsOpen, type PendingPromptPayRecord } from '@/src/lib/billing/promptpay-pending';
import {
  checkoutRefusalMessage,
  resolveCheckoutEligibility,
  type CheckoutRefusalReason,
} from '@/src/lib/billing/checkout-eligibility';
import { createClient } from '@/src/lib/supabase/server';

/**
 * Starting a purchase, abandoning an unpaid one, and opening the provider's
 * billing portal.
 *
 * What a caller may send is a plan key and a payment method. Not an amount, not
 * a tier, not a discount, not a customer identifier, not a user id — every one
 * of those is read on the server from the session or the account's own row. And
 * the rail selects only *how* money is collected: both rails bill the same Price
 * object, so naming the other one cannot change what anybody is charged. That is
 * the whole security argument for this file: the request surface is too narrow
 * to carry a lie worth telling.
 *
 * Three more properties this file exists to hold:
 *
 *   * Nothing is unlocked here. A successful return is a URL to the provider's
 *     hosted page and nothing more. Entitlement changes only when a signed
 *     webhook arrives, which is a different route with a different trust story.
 *     That is true of the PromptPay rail twice over: the invoice it returns is a
 *     request for money, and the plan opens when the bank confirms.
 *
 *   * A PromptPay invoice that cannot be recorded is unmade. Past the point
 *     where the provider has created something payable, a failure has to undo it
 *     rather than return an error and leave an invoice nobody can see or cancel.
 *
 *   * With billing unconfigured, the provider SDK is never even loaded. The
 *     import is dynamic and sits *after* the eligibility gate, so a deployment
 *     without credentials cannot make a network call to Stripe by any path
 *     through this module.
 */

export type CheckoutFailureCode =
  | 'BILLING_UNAVAILABLE'
  | 'INVALID_PLAN'
  | 'PLAN_UNAVAILABLE'
  | 'INVALID_PAYMENT_METHOD'
  | 'PAYMENT_METHOD_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'EMAIL_UNVERIFIED'
  | 'FOUNDER_USED'
  /** A subscription is already live; plan changes belong in the portal. */
  | 'ALREADY_SUBSCRIBED'
  /** An unpaid PromptPay invoice is still payable; pay or abandon it first. */
  | 'PROMPTPAY_INVOICE_OPEN'
  | 'UNAVAILABLE';

export type StartCheckoutResult =
  | {
    ok: true;
    url: string;
    /**
     * Which rail the URL leads to. The browser only navigates, but a PromptPay
     * destination is a QR the reader may need to keep open on another device,
     * so the caller is told which one it is rather than having to guess.
     */
    paymentMethod: BillingPaymentMethod;
  }
  | { ok: false; code: CheckoutFailureCode; message: string };

export type AbandonInvoiceResult =
  | { ok: true; message: string }
  | { ok: false; code: CheckoutFailureCode; message: string };

export type BillingPortalResult =
  | { ok: true; url: string }
  | { ok: false; code: CheckoutFailureCode; message: string };

export type PromptPayRenewalResult =
  | { ok: true; url: string }
  | { ok: false; code: CheckoutFailureCode; message: string };

/** Refusal reasons carry a code as well as a message, so callers can branch. */
const REFUSAL_CODE: Readonly<Record<CheckoutRefusalReason, CheckoutFailureCode>> = {
  'billing-disabled': 'BILLING_UNAVAILABLE',
  'unknown-plan': 'INVALID_PLAN',
  'plan-unavailable': 'PLAN_UNAVAILABLE',
  'unknown-payment-method': 'INVALID_PAYMENT_METHOD',
  'payment-method-unavailable': 'PAYMENT_METHOD_UNAVAILABLE',
  unauthenticated: 'UNAUTHENTICATED',
  'email-unverified': 'EMAIL_UNVERIFIED',
  'founder-already-used': 'FOUNDER_USED',
  'already-subscribed': 'ALREADY_SUBSCRIBED',
  'promptpay-invoice-open': 'PROMPTPAY_INVOICE_OPEN',
};

const GENERIC_FAILURE = 'เริ่มการชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
const PORTAL_UNAVAILABLE = 'ยังไม่มีข้อมูลการชำระเงินสำหรับบัญชีนี้';
const NO_PENDING_INVOICE = 'ไม่พบใบแจ้งหนี้ที่รอชำระ';
const INVOICE_ABANDONED = 'ยกเลิกใบแจ้งหนี้แล้ว เลือกวิธีชำระเงินใหม่ได้เลย';
const INVOICE_ALREADY_PAID = 'ใบแจ้งหนี้นี้ชำระเงินแล้ว กรุณารีเฟรชหน้านี้เพื่อดูสิทธิ์ล่าสุด';

const PROMPTPAY_RENEWAL_NOT_READY = 'ชำระได้เมื่อใกล้หมดอายุ';

type AuditEvent =
  | 'billing_checkout_started'
  | 'billing_checkout_refused'
  | 'billing_checkout_failed'
  | 'billing_portal_opened'
  | 'billing_portal_failed'
  | 'billing_pending_invoice_abandoned'
  | 'billing_pending_invoice_abandon_failed'
  | 'billing_promptpay_renewal_opened'
  | 'billing_promptpay_renewal_failed';

/**
 * The same structured-log shape the rest of the server uses. The event name and
 * a typed code are the whole record: no account identifier, no mailbox, no
 * provider identifier, no key. A plan key is product configuration rather than
 * personal data, so it is the one detail worth keeping.
 */
function record(event: AuditEvent, detail?: string) {
  const payload = JSON.stringify({ event, ...(detail ? { detail } : {}) });
  if (event.endsWith('_failed') || event.endsWith('_refused')) console.warn(payload);
  else console.info(payload);
}

/**
 * A key that is stable for a repeated submit and different once the account's
 * billing state has actually moved.
 *
 * Two clicks a moment apart produce the same key, so the provider returns the
 * same checkout session instead of opening a second one. A later attempt after
 * the subscription has changed produces a different key, so a genuine new
 * purchase is never collapsed into a stale session. Hashed so the account
 * identifier is not embedded in a value handed to a third party.
 */
function checkoutIdempotencyKey(input: {
  userId: string;
  planKey: string;
  paymentMethod: BillingPaymentMethod;
  status: string;
  periodEnd: string | null;
  /**
   * The invoice attempt this account last made, if any.
   *
   * On the PromptPay rail an abandoned attempt must not be collapsed into the
   * one that replaces it: the provider replays a repeated key for a day, and
   * replaying a cancelled subscription would hand the reader a QR for an invoice
   * that can never be paid. The abandoned row survives precisely so this value
   * changes.
   */
  pendingStamp: string;
}): string {
  return createHash('sha256')
    .update([
      input.userId,
      input.planKey,
      input.paymentMethod,
      input.status,
      input.periodEnd ?? 'none',
      input.pendingStamp,
    ].join(':'))
    .digest('hex')
    .slice(0, 48);
}

/** Identifies one purchase attempt, so the next one cannot reuse its key. */
function pendingStampOf(pending: PendingPromptPayRecord | null): string {
  return pending ? `${pending.createdAt}:${pending.status}` : 'none';
}

/**
 * Begin a purchase.
 *
 * `planKey` is the only argument and is treated as untrusted until the
 * allowlist in `resolveCheckoutEligibility` has accepted it. The stored
 * administrator role may admit an account during an internal rollout, but a
 * running access preview is never consulted. Preview changes what an operator
 * can *see*; it must never change what anybody is charged or which plan is
 * bought.
 */
export async function startCheckoutAction(
  planKey: string,
  paymentMethod: string,
): Promise<StartCheckoutResult> {
  const client = await createClient();
  if (!client) {
    record('billing_checkout_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }

  const { data: { user }, error: authError } = await client.auth.getUser();
  const authenticated = !authError && Boolean(user);

  /*
   * The mailbox confirmation is read from the verified user record on the
   * server. A client could otherwise claim it, and it is what stands between an
   * unverified address and a recurring charge.
   */
  const emailVerified = Boolean(user?.email_confirmed_at);
  let role: 'user' | 'admin' = 'user';
  if (authenticated) {
    const roleResult = await client.from('user_roles').select('role').maybeSingle();
    if (roleResult.error) {
      record('billing_checkout_failed', 'ROLE_UNAVAILABLE');
      return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
    }
    role = roleResult.data?.role === 'admin' ? 'admin' : 'user';
  }
  const availability = getBillingAvailability({
    userId: user?.id ?? null,
    role,
  });

  // Only read once identity is known. A signed out caller never reaches a
  // database read.
  let founderPromoApplied = false;
  let hasLiveSubscription = false;
  let status = 'basic';
  let periodEnd: string | null = null;
  let pending: PendingPromptPayRecord | null = null;
  let hasOpenPromptPayInvoice = false;
  if (authenticated) {
    try {
      const config = getBillingConfig();
      const snapshot = await readBillingSnapshot(client);
      founderPromoApplied = snapshot?.founder_promo_applied ?? false;
      status = snapshot?.status ?? 'basic';
      periodEnd = snapshot?.current_period_end ?? null;
      const modeMatches = Boolean(config && snapshot?.billing_provider_mode === config.providerMode);
      const storedPlanKey = isBillingPlanKey(snapshot?.billing_plan_key)
        ? snapshot.billing_plan_key
        : null;
      hasLiveSubscription = modeMatches && (
        holdsLiveSubscription({
          status,
          planKey: storedPlanKey,
          collectionMethod: snapshot?.billing_collection_method ?? null,
          currentPeriodEnd: periodEnd,
          now: snapshot?.database_now ?? null,
        })
        || holdsReusablePromptPaySubscription({
          status,
          planKey: storedPlanKey,
          collectionMethod: snapshot?.billing_collection_method ?? null,
        })
      );
      if (config) {
        pending = await readPendingPromptPayPayment(client, config.providerMode);
        /*
         * Judged against the database's clock, never this process's. An expiry
         * decided by a server whose time has drifted would either lock a reader
         * out of buying or let two payable invoices exist at once — and with no
         * snapshot there is no clock and no pending row either.
         */
        hasOpenPromptPayInvoice = Boolean(snapshot)
          && pendingPromptPayIsOpen(pending, snapshot!.database_now);
      }
    } catch {
      record('billing_checkout_failed', 'SNAPSHOT_UNAVAILABLE');
      return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
    }
  }

  const eligibility = resolveCheckoutEligibility({
    planKey,
    paymentMethod,
    availablePlanKeys: availability.availablePlanKeys,
    availablePaymentMethods: availability.paymentMethods,
    billingEnabled: availability.enabled,
    authenticated,
    emailVerified,
    founderPromoApplied,
    hasLiveSubscription,
    hasOpenPromptPayInvoice,
  });

  if (!eligibility.ok) {
    record('billing_checkout_refused', eligibility.reason);
    return {
      ok: false,
      code: REFUSAL_CODE[eligibility.reason],
      message: checkoutRefusalMessage(eligibility.reason),
    };
  }

  // Past the gate, so billing is configured by construction; the check keeps the
  // type honest and fails closed if the two ever disagree.
  const config = getBillingConfig();
  if (!config || !user) {
    record('billing_checkout_refused', 'billing-disabled');
    return {
      ok: false,
      code: 'BILLING_UNAVAILABLE',
      message: checkoutRefusalMessage('billing-disabled'),
    };
  }

  try {
    const request = {
      config,
      plan: eligibility.plan,
      userId: user.id,
      email: user.email ?? '',
      existingCustomerId: await readBillingCustomerId(user.id, config.providerMode),
      idempotencyKey: checkoutIdempotencyKey({
        userId: user.id,
        planKey: eligibility.plan.key,
        paymentMethod: eligibility.paymentMethod,
        status,
        periodEnd,
        pendingStamp: pendingStampOf(pending),
      }),
    };

    // Loaded only now. With billing switched off the provider SDK is never
    // imported, let alone contacted.
    const provider = await import('@/src/lib/billing/providers/stripe/stripe-provider');

    if (eligibility.paymentMethod === 'promptpay') {
      const invoice = await provider.createStripePromptPaySubscription(request);
      /*
       * From here the invoice is payable at the provider, so anything that goes
       * wrong must *unmake* it rather than return an error and walk away. An
       * invoice we failed to record is one nobody can see, cancel or match a
       * webhook to — and somebody could still pay it.
       */
      let recorded: PendingPaymentOutcome | 'record-failed';
      try {
        recorded = await recordPendingPromptPayPayment({
          userId: user.id,
          providerMode: config.providerMode,
          planKey: eligibility.plan.key,
          subscriptionId: invoice.subscriptionId,
          invoiceId: invoice.invoiceId,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
          amountBaht: invoice.amountBaht,
          dueAt: invoice.dueAt,
        });
      } catch {
        recorded = 'record-failed';
      }

      if (recorded !== 'recorded') {
        try {
          await provider.abandonStripePromptPaySubscription(config, invoice.subscriptionId);
        } catch {
          // Left to expire at its due date instead. Nothing was granted, and the
          // reader is told the purchase did not start either way.
          record('billing_checkout_failed', 'PROMPTPAY_ORPHAN_INVOICE');
        }
        record('billing_checkout_refused', recorded);
        return recorded === 'record-failed'
          ? { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE }
          : {
            ok: false,
            code: 'PROMPTPAY_INVOICE_OPEN',
            message: checkoutRefusalMessage('promptpay-invoice-open'),
          };
      }

      revalidatePath('/settings/subscription');
      record('billing_checkout_started', `${eligibility.plan.key}:promptpay`);
      return { ok: true, url: invoice.hostedInvoiceUrl, paymentMethod: 'promptpay' };
    }

    const session = await provider.createStripeCheckoutSession(request);
    record('billing_checkout_started', eligibility.plan.key);
    return { ok: true, url: session.url, paymentMethod: 'card' };
  } catch {
    record('billing_checkout_failed', `${eligibility.plan.key}:${eligibility.paymentMethod}`);
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}

/**
 * Open the provider-generated next invoice on the existing PromptPay
 * subscription. It creates nothing and changes no entitlement. Before the paid
 * period ends there is no non-overlapping renewal invoice to open, so it fails
 * closed with the same message shown beside the disabled button.
 */
export async function openPromptPayRenewalAction(): Promise<PromptPayRenewalResult> {
  const config = getBillingConfig();
  if (!config || !config.paymentMethods.includes('promptpay')) {
    return {
      ok: false,
      code: 'BILLING_UNAVAILABLE',
      message: checkoutRefusalMessage('billing-disabled'),
    };
  }

  const client = await createClient();
  if (!client) return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: checkoutRefusalMessage('unauthenticated'),
    };
  }

  try {
    const [snapshot, existingPending] = await Promise.all([
      readBillingSnapshot(client),
      readPendingPromptPayPayment(client, config.providerMode),
    ]);
    if (
      existingPending?.hostedInvoiceUrl
      && snapshot
      && pendingPromptPayIsOpen(existingPending, snapshot.database_now)
    ) {
      record('billing_promptpay_renewal_opened', 'pending-reused');
      return { ok: true, url: existingPending.hostedInvoiceUrl };
    }

    const periodEnd = snapshot?.current_period_end
      ? Date.parse(snapshot.current_period_end)
      : Number.NaN;
    const databaseNow = snapshot ? Date.parse(snapshot.database_now) : Number.NaN;
    if (
      !snapshot
      || snapshot.billing_provider_mode !== config.providerMode
      || snapshot.billing_collection_method !== 'send_invoice'
      || !isBillingPlanKey(snapshot.billing_plan_key)
      || !Number.isFinite(periodEnd)
      || !Number.isFinite(databaseNow)
      || periodEnd > databaseNow
    ) {
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: PROMPTPAY_RENEWAL_NOT_READY };
    }

    const identity = await readPromptPaySubscriptionIdentity(user.id, config.providerMode);
    if (!identity || identity.planKey !== snapshot.billing_plan_key) {
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: PROMPTPAY_RENEWAL_NOT_READY };
    }

    const { findStripePromptPayRenewalInvoice } = await import(
      '@/src/lib/billing/providers/stripe/stripe-provider'
    );
    const invoice = await findStripePromptPayRenewalInvoice({
      config,
      userId: user.id,
      plan: billingPlan(identity.planKey),
      subscriptionId: identity.subscriptionId,
    });
    if (!invoice) {
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: PROMPTPAY_RENEWAL_NOT_READY };
    }

    const invoiceRecord: PendingPromptPayRecord = {
      planKey: identity.planKey,
      paymentMethod: 'promptpay',
      status: 'awaiting_payment',
      amountBaht: invoice.amountBaht,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      dueAt: invoice.dueAt,
      createdAt: snapshot.database_now,
    };
    if (!pendingPromptPayIsOpen(invoiceRecord, snapshot.database_now)) {
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: PROMPTPAY_RENEWAL_NOT_READY };
    }

    const recorded = await recordPendingPromptPayPayment({
      userId: user.id,
      providerMode: config.providerMode,
      planKey: identity.planKey,
      subscriptionId: identity.subscriptionId,
      invoiceId: invoice.invoiceId,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      amountBaht: invoice.amountBaht,
      dueAt: invoice.dueAt,
    });
    if (recorded !== 'recorded') {
      const concurrent = await readPendingPromptPayPayment(client, config.providerMode);
      if (
        concurrent?.hostedInvoiceUrl
        && pendingPromptPayIsOpen(concurrent, snapshot.database_now)
      ) {
        record('billing_promptpay_renewal_opened', 'pending-race-reused');
        return { ok: true, url: concurrent.hostedInvoiceUrl };
      }
      return { ok: false, code: 'PROMPTPAY_INVOICE_OPEN', message: GENERIC_FAILURE };
    }

    revalidatePath('/settings/subscription');
    record('billing_promptpay_renewal_opened');
    return { ok: true, url: invoice.hostedInvoiceUrl };
  } catch {
    record('billing_promptpay_renewal_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}

/**
 * Abandon an unpaid PromptPay invoice.
 *
 * Takes nothing: the invoice is found from the caller's own row, so this cannot
 * be pointed at anybody else's. It grants nothing and withdraws nothing — an
 * unpaid invoice never opened a plan, so cancelling it changes no entitlement.
 *
 * The provider is asked first and our record is marked only if it agreed. An
 * invoice that turns out to have been paid is left alone and reported as such,
 * because at that point money has moved and the right control is the portal.
 */
export async function abandonPromptPayInvoiceAction(): Promise<AbandonInvoiceResult> {
  const config = getBillingConfig();
  if (!config) {
    record('billing_pending_invoice_abandon_failed', 'BILLING_UNAVAILABLE');
    return {
      ok: false,
      code: 'BILLING_UNAVAILABLE',
      message: checkoutRefusalMessage('billing-disabled'),
    };
  }

  const client = await createClient();
  if (!client) {
    record('billing_pending_invoice_abandon_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    record('billing_pending_invoice_abandon_failed', 'UNAUTHENTICATED');
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: checkoutRefusalMessage('unauthenticated'),
    };
  }

  try {
    const identity = await readPendingPromptPayIdentity(user.id, config.providerMode);
    if (!identity || identity.status !== 'awaiting_payment') {
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: NO_PENDING_INVOICE };
    }

    const { abandonStripePromptPaySubscription } = await import('@/src/lib/billing/providers/stripe/stripe-provider');
    const outcome = await abandonStripePromptPaySubscription(config, identity.subscriptionId);
    if (outcome === 'already-paid') {
      record('billing_pending_invoice_abandon_failed', 'ALREADY_PAID');
      return { ok: false, code: 'ALREADY_SUBSCRIBED', message: INVOICE_ALREADY_PAID };
    }

    await cancelPendingPromptPayPayment({
      userId: user.id,
      providerMode: config.providerMode,
      subscriptionId: identity.subscriptionId,
    });
    revalidatePath('/settings/subscription');
    record('billing_pending_invoice_abandoned');
    return { ok: true, message: INVOICE_ABANDONED };
  } catch {
    record('billing_pending_invoice_abandon_failed', 'PROVIDER_ERROR');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}

/**
 * Open the provider's billing portal for the account that asked.
 *
 * The customer identifier is looked up server-side from the caller's own row and
 * handed straight to the provider. It is never accepted as an argument, and
 * never returned to the browser — otherwise this action would be a way to open
 * somebody else's billing history by guessing an identifier.
 */
export async function openBillingPortalAction(): Promise<BillingPortalResult> {
  const config = getBillingConfig();
  if (!config) {
    record('billing_portal_failed', 'BILLING_UNAVAILABLE');
    return {
      ok: false,
      code: 'BILLING_UNAVAILABLE',
      message: checkoutRefusalMessage('billing-disabled'),
    };
  }

  const client = await createClient();
  if (!client) {
    record('billing_portal_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    record('billing_portal_failed', 'UNAUTHENTICATED');
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: checkoutRefusalMessage('unauthenticated'),
    };
  }

  try {
    const customerId = await readBillingCustomerId(user.id, config.providerMode);
    if (!customerId) {
      record('billing_portal_failed', 'NO_CUSTOMER');
      return { ok: false, code: 'PLAN_UNAVAILABLE', message: PORTAL_UNAVAILABLE };
    }
    const { createStripePortalSession } = await import('@/src/lib/billing/providers/stripe/stripe-provider');
    const url = await createStripePortalSession(config, customerId);
    record('billing_portal_opened');
    return { ok: true, url };
  } catch {
    record('billing_portal_failed', 'PROVIDER_ERROR');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}
