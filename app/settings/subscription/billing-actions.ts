'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getBillingAvailability, getBillingConfig } from '@/src/lib/billing/billing-server';
import { resolveBetaAccessForRequest, recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { BETA_ACCESS_UNAVAILABLE_MESSAGE, betaWaitlistCopy } from '@/src/lib/beta/beta-stages';
import { captureServerError } from '@/src/lib/monitoring/report';
import {
  consumeRateLimit, rateLimitMessage, resolveClientAddress, type RateLimitScope,
} from '@/src/lib/security/rate-limit';
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
import {
  billingPlan,
  isBillingPlanKey,
  type BillingInterval,
  type BillingPlanKey,
} from '@/src/lib/billing/billing-plans';
import { pendingPromptPayIsOpen, type PendingPromptPayRecord } from '@/src/lib/billing/promptpay-pending';
import {
  checkoutRefusalMessage,
  resolveCheckoutEligibility,
  type CheckoutRefusalReason,
} from '@/src/lib/billing/checkout-eligibility';
import {
  currentPurchasePolicyVersions,
  verifyPurchaseConsent,
  PURCHASE_CONSENT_REQUIRED_MESSAGE,
  PURCHASE_CONSENT_STALE_MESSAGE,
  type PurchaseConsentClaim,
} from '@/src/lib/billing/purchase-consent';
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
  /** The controlled rollout has not admitted this account yet. */
  | 'BETA_NOT_ADMITTED'
  /** The rollout could not be read, so no purchase is started. Retryable. */
  | 'BETA_ACCESS_UNAVAILABLE'
  /** The purchase terms were not accepted. */
  | 'CONSENT_REQUIRED'
  /** Accepted, but against wording this build no longer publishes. */
  | 'CONSENT_STALE'
  /** Too many attempts in a short window. */
  | 'RATE_LIMITED'
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

/**
 * The shared bound on every money path in this file.
 *
 * Each of these actions creates or opens an object at the provider, so the cost
 * of a loop is not ours alone. The limiter lives in the database because this
 * runs on serverless instances that share no memory; it fails open, because a
 * limiter that cannot be reached must not close checkout. See `rate-limit.ts`.
 */
async function withinRateLimit(
  client: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  scope: RateLimitScope,
  userId: string | null,
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const outcome = await consumeRateLimit(client, {
    scope,
    userId,
    clientAddress: await resolveClientAddress(),
  });
  return outcome.allowed
    ? { allowed: true }
    : { allowed: false, message: rateLimitMessage(outcome.retryAfterSeconds) };
}

type AuditEvent =
  | 'billing_checkout_started'
  | 'billing_checkout_rate_limited'
  | 'billing_checkout_beta_refused'
  | 'billing_checkout_beta_unresolved'
  | 'billing_checkout_consent_refused'
  | 'billing_purchase_consent_recorded'
  | 'billing_purchase_consent_failed'
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
  if (event.endsWith('_failed') || event.endsWith('_refused') || event.endsWith('_unresolved')) {
    console.warn(payload);
  } else console.info(payload);
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
 * Three arguments, all untrusted until checked, and none of them able to change
 * what anybody is charged. `planKey` and `paymentMethod` are matched against
 * closed allowlists in `resolveCheckoutEligibility`. `consent` carries a boolean
 * and two policy version strings that the server compares against the versions
 * *it* publishes — a client cannot invent a version, only echo the one it was
 * rendered with, and echoing the wrong one is refused rather than accepted.
 *
 * The stored administrator role may admit an account during an internal rollout,
 * but a running access preview is never consulted. Preview changes what an
 * operator can *see*; it must never change what anybody is charged or which plan
 * is bought.
 */
export async function startCheckoutAction(
  planKey: string,
  paymentMethod: string,
  consent: PurchaseConsentClaim,
): Promise<StartCheckoutResult> {
  const client = await createClient();
  if (!client) {
    record('billing_checkout_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }

  const { data: { user }, error: authError } = await client.auth.getUser();
  const authenticated = !authError && Boolean(user);

  const bound = await withinRateLimit(client, 'checkout.start', user?.id ?? null);
  if (!bound.allowed) {
    record('billing_checkout_rate_limited');
    return { ok: false, code: 'RATE_LIMITED', message: bound.message };
  }

  /*
   * The controlled rollout, checked before anything is looked up and before the
   * provider SDK could possibly be loaded.
   *
   * It gates *starting a new purchase* and nothing else. A reader who already
   * pays is admitted by the database's own rule, so a rollout stage can never
   * strand an existing subscriber — and this action is not on the renewal or
   * portal path, which stay open in every stage by construction.
   */
  if (authenticated) {
    const beta = await resolveBetaAccessForRequest();
    /*
     * An unreadable rollout stops a *new* purchase here, before the provider SDK
     * could be loaded and long before anything payable exists. Refusing costs a
     * reader one retry; admitting on an answer nobody gave would open the door a
     * closed stage exists to hold shut, and a checkout is the expensive half of
     * that mistake to undo. Renewal, the portal, refunds and every entitlement an
     * account already holds are on other paths and are untouched by this.
     */
    if (beta.resolution === 'unavailable') {
      record('billing_checkout_beta_unresolved');
      return {
        ok: false,
        code: 'BETA_ACCESS_UNAVAILABLE',
        message: BETA_ACCESS_UNAVAILABLE_MESSAGE,
      };
    }
    if (!beta.admitted) {
      record('billing_checkout_beta_refused', beta.reason);
      return {
        ok: false,
        code: 'BETA_NOT_ADMITTED',
        message: betaWaitlistCopy(beta.reason, beta.stage).body,
      };
    }
  }

  /*
   * The purchase terms, checked here — before any account state is read, before
   * a provider customer is looked up, and long before the provider SDK could be
   * imported. A refusal costs a reader one tick of a checkbox and creates
   * nothing anywhere.
   *
   * The versions are compared against this deployment's own copy of the
   * documents, so an acceptance given against superseded wording is refused with
   * an instruction to re-read rather than quietly treated as agreement to text
   * nobody is showing any more. Only new purchases pass through here: renewal,
   * the portal, refunds and existing entitlements are on other paths.
   */
  const policyVersions = currentPurchasePolicyVersions();
  const verdict = verifyPurchaseConsent(consent, policyVersions);
  if (verdict !== 'accepted') {
    record('billing_checkout_consent_refused', verdict);
    return verdict === 'stale-policy'
      ? { ok: false, code: 'CONSENT_STALE', message: PURCHASE_CONSENT_STALE_MESSAGE }
      : { ok: false, code: 'CONSENT_REQUIRED', message: PURCHASE_CONSENT_REQUIRED_MESSAGE };
  }

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

  /*
   * The agreement is written down before anything payable exists, and a failure
   * to write it stops the purchase.
   *
   * Failing closed is the whole point: a checkout that proceeds without a
   * recorded consent is a charge nobody can later show the buyer agreed to, and
   * the cost of refusing is one retry. Recorded *after* eligibility so a refused
   * attempt does not file an agreement for a purchase that never started, and
   * *before* the provider so no invoice can exist without one.
   */
  const consentRecorded = await recordPurchaseConsent(client, {
    planKey: eligibility.plan.key,
    interval: eligibility.plan.interval,
    paymentMethod: eligibility.paymentMethod,
    versions: policyVersions,
  });
  if (!consentRecorded) {
    record('billing_purchase_consent_failed', eligibility.plan.key);
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
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
      await recordBetaFunnelEvent({
        event: 'checkout_started',
        planKey: eligibility.plan.key,
        paymentRail: 'promptpay',
      });
      return { ok: true, url: invoice.hostedInvoiceUrl, paymentMethod: 'promptpay' };
    }

    const session = await provider.createStripeCheckoutSession(request);
    record('billing_checkout_started', eligibility.plan.key);
    await recordBetaFunnelEvent({
      event: 'checkout_started',
      planKey: eligibility.plan.key,
      paymentRail: 'card',
    });
    return { ok: true, url: session.url, paymentMethod: 'card' };
  } catch (cause) {
    record('billing_checkout_failed', `${eligibility.plan.key}:${eligibility.paymentMethod}`);
    captureServerError({
      scope: 'billing.checkout',
      cause,
      context: {
        operation: 'create_session',
        planKey: eligibility.plan.key,
        paymentRail: eligibility.paymentMethod,
        providerMode: config.providerMode,
      },
    });
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}

/**
 * Write the acceptance down.
 *
 * The routine takes the account from the session, so nothing identifying is sent
 * — only the shape of the purchase and the two versions. It is idempotent: a
 * second press, or a retry of a request that already succeeded, reaffirms the
 * one row rather than filing a duplicate agreement.
 *
 * Returns `false` for every failure, including an unreachable database and a
 * deployment whose migration has not run yet. The caller treats that as a
 * refusal, which is the fail-closed direction — see the note at the call site.
 */
async function recordPurchaseConsent(
  client: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  input: {
    planKey: BillingPlanKey;
    interval: BillingInterval;
    paymentMethod: BillingPaymentMethod;
    versions: { subscriptionPolicy: string; refundPolicy: string };
  },
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc('record_purchase_consent', {
      input_plan_key: input.planKey,
      input_billing_interval: input.interval,
      input_payment_rail: input.paymentMethod,
      input_subscription_policy_version: input.versions.subscriptionPolicy,
      input_refund_policy_version: input.versions.refundPolicy,
    });
    if (error) throw error;
    const outcome = data?.[0]?.outcome;
    if (outcome !== 'recorded' && outcome !== 'reaffirmed') return false;
    record('billing_purchase_consent_recorded', `${input.planKey}:${outcome}`);
    return true;
  } catch {
    return false;
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

  /*
   * Bounded, but never gated by the rollout stage. This opens the next invoice
   * on a subscription somebody already bought; refusing it because a cohort is
   * closed would strand a paying reader mid-renewal.
   */
  const bound = await withinRateLimit(client, 'checkout.promptpay-renewal', user.id);
  if (!bound.allowed) return { ok: false, code: 'RATE_LIMITED', message: bound.message };

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
  } catch (cause) {
    record('billing_promptpay_renewal_failed', 'UNAVAILABLE');
    captureServerError({
      scope: 'billing.promptpay-renewal',
      cause,
      context: { operation: 'open_renewal', paymentRail: 'promptpay' },
    });
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

  // Also ungated by the rollout: the portal is how somebody cancels, updates a
  // card or reads their own invoices, and every one of those must stay reachable.
  const bound = await withinRateLimit(client, 'billing.portal', user.id);
  if (!bound.allowed) return { ok: false, code: 'RATE_LIMITED', message: bound.message };

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
  } catch (cause) {
    record('billing_portal_failed', 'PROVIDER_ERROR');
    captureServerError({
      scope: 'billing.portal',
      cause,
      context: { operation: 'open_portal', providerMode: config.providerMode },
    });
    return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
  }
}
