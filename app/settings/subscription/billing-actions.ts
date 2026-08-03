'use server';

import { createHash } from 'node:crypto';
import { getBillingAvailability, getBillingConfig } from '@/src/lib/billing/billing-server';
import { readBillingCustomerId, readBillingSnapshot } from '@/src/lib/billing/billing-repository';
import {
  checkoutRefusalMessage,
  resolveCheckoutEligibility,
  type CheckoutRefusalReason,
} from '@/src/lib/billing/checkout-eligibility';
import { createClient } from '@/src/lib/supabase/server';

/**
 * Starting a purchase, and opening the provider's billing portal.
 *
 * What a caller may send is one plan key. Not an amount, not a tier, not a
 * discount, not a customer identifier, not a user id — every one of those is
 * read on the server from the session or the account's own row. That is the
 * whole security argument for this file: the request surface is too narrow to
 * carry a lie worth telling.
 *
 * Two more properties this file exists to hold:
 *
 *   * Nothing is unlocked here. A successful return is a URL to the provider's
 *     hosted page and nothing more. Entitlement changes only when a signed
 *     webhook arrives, which is a different route with a different trust story.
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
  | 'UNAUTHENTICATED'
  | 'EMAIL_UNVERIFIED'
  | 'FOUNDER_USED'
  | 'UNAVAILABLE';

export type StartCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; code: CheckoutFailureCode; message: string };

export type BillingPortalResult =
  | { ok: true; url: string }
  | { ok: false; code: CheckoutFailureCode; message: string };

/** Refusal reasons carry a code as well as a message, so callers can branch. */
const REFUSAL_CODE: Readonly<Record<CheckoutRefusalReason, CheckoutFailureCode>> = {
  'billing-disabled': 'BILLING_UNAVAILABLE',
  'unknown-plan': 'INVALID_PLAN',
  'plan-unavailable': 'PLAN_UNAVAILABLE',
  unauthenticated: 'UNAUTHENTICATED',
  'email-unverified': 'EMAIL_UNVERIFIED',
  'founder-already-used': 'FOUNDER_USED',
};

const GENERIC_FAILURE = 'เริ่มการชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
const PORTAL_UNAVAILABLE = 'ยังไม่มีข้อมูลการชำระเงินสำหรับบัญชีนี้';

type AuditEvent =
  | 'billing_checkout_started'
  | 'billing_checkout_refused'
  | 'billing_checkout_failed'
  | 'billing_portal_opened'
  | 'billing_portal_failed';

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
function checkoutIdempotencyKey(
  userId: string,
  planKey: string,
  status: string,
  periodEnd: string | null,
): string {
  return createHash('sha256')
    .update(`${userId}:${planKey}:${status}:${periodEnd ?? 'none'}`)
    .digest('hex')
    .slice(0, 48);
}

/**
 * Begin a purchase.
 *
 * `planKey` is the only argument and is treated as untrusted until the
 * allowlist in `resolveCheckoutEligibility` has accepted it. Note what is NOT
 * read anywhere below: the administrator role, and any running access preview.
 * A preview changes what an operator can *see*; it must never change what
 * anybody is charged or which plan is bought.
 */
export async function startCheckoutAction(planKey: string): Promise<StartCheckoutResult> {
  const availability = getBillingAvailability();

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

  // Only read for the Founder flag, and only once identity is known. A signed
  // out caller never reaches a database read.
  let founderPromoApplied = false;
  let status = 'basic';
  let periodEnd: string | null = null;
  if (authenticated) {
    try {
      const snapshot = await readBillingSnapshot(client);
      founderPromoApplied = snapshot?.founder_promo_applied ?? false;
      status = snapshot?.status ?? 'basic';
      periodEnd = snapshot?.current_period_end ?? null;
    } catch {
      record('billing_checkout_failed', 'SNAPSHOT_UNAVAILABLE');
      return { ok: false, code: 'UNAVAILABLE', message: GENERIC_FAILURE };
    }
  }

  const eligibility = resolveCheckoutEligibility({
    planKey,
    availablePlanKeys: availability.availablePlanKeys,
    billingEnabled: availability.enabled,
    authenticated,
    emailVerified,
    founderPromoApplied,
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
    // Loaded only now. With billing switched off the provider SDK is never
    // imported, let alone contacted.
    const { createStripeCheckoutSession } = await import('@/src/lib/billing/providers/stripe/stripe-provider');
    const session = await createStripeCheckoutSession({
      config,
      plan: eligibility.plan,
      userId: user.id,
      email: user.email ?? '',
      existingCustomerId: await readBillingCustomerId(user.id),
      idempotencyKey: checkoutIdempotencyKey(user.id, eligibility.plan.key, status, periodEnd),
    });
    record('billing_checkout_started', eligibility.plan.key);
    return { ok: true, url: session.url };
  } catch {
    record('billing_checkout_failed', eligibility.plan.key);
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
    const customerId = await readBillingCustomerId(user.id);
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
