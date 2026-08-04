import 'server-only';

import Stripe from 'stripe';
import type { BillingConfig } from '../../billing-config';
import {
  BILLING_METADATA_PLAN_KEY,
  BILLING_METADATA_USER_ID,
  type NormalizedBillingEvent,
} from '../../billing-events';
import type { BillingPlanDefinition } from '../../billing-plans';
import { classifyStripeEvent, normalizeStripeEvent, subscriptionIdFromEvent } from './normalize-stripe-event';

/**
 * The Stripe adapter: the only module in the product that talks to Stripe.
 *
 * Everything above it works in the provider-agnostic vocabulary of
 * `billing-events.ts`, so swapping providers means writing a sibling of this
 * file rather than touching the checkout guard, the webhook route, the database
 * routine or the UI.
 *
 * The secret key never leaves this module, and `server-only` makes that a build
 * error rather than a code-review habit.
 */

/** One client per secret key. Constructing a Stripe instance is not free. */
const clients = new Map<string, Stripe>();

function stripeClient(config: BillingConfig): Stripe {
  const existing = clients.get(config.secretKey);
  if (existing) return existing;
  const client = new Stripe(config.secretKey, {
    /*
     * `apiVersion` is deliberately NOT set. Omitting it uses the version this
     * SDK release is built against, which is the version its typings describe —
     * and the shapes this code reads are version-sensitive in ways that fail
     * silently: the billing period moved onto subscription items, and an
     * invoice's subscription link moved under `parent`. Pinning a different
     * string here would compile and then read `undefined` at runtime.
     */
    appInfo: { name: 'PortKheaw', url: 'https://portkheaw.vercel.app' },
    // Vercel's runtime provides fetch; this avoids the Node http agent entirely.
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
  clients.set(config.secretKey, client);
  return client;
}

export interface CheckoutSessionRequest {
  config: BillingConfig;
  plan: BillingPlanDefinition;
  /** Our user id. Becomes the metadata every later event is matched on. */
  userId: string;
  email: string;
  /** Reused when the account has bought before, so one account is one customer. */
  existingCustomerId: string | null;
  /**
   * Stable per user and plan. Stripe treats a repeated key as the same request,
   * which is what makes a double-clicked Subscribe button one checkout session
   * rather than two.
   */
  idempotencyKey: string;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

/**
 * Create a hosted checkout session.
 *
 * Card details are entered on Stripe's own page and never touch this server, so
 * no card number or CVV exists anywhere in this system to store or leak.
 *
 * The amount is never sent. Only a price identifier is, and Stripe holds the
 * amount behind it — so neither a browser nor a bug in this file can change what
 * someone is charged.
 */
export async function createStripeCheckoutSession(
  request: CheckoutSessionRequest,
): Promise<CheckoutSessionResult> {
  const { config, plan } = request;
  const priceId = config.prices[plan.key];
  if (!priceId) throw new Error('BILLING_PLAN_NOT_CONFIGURED');

  const metadata = {
    [BILLING_METADATA_USER_ID]: request.userId,
    [BILLING_METADATA_PLAN_KEY]: plan.key,
  };

  /*
   * The Founder promotion is a coupon with `duration: once` on top of the
   * ordinary annual price — never a second, cheaper price object. That is what
   * guarantees the second year bills at full rate: the subscription sits on the
   * full price from day one and the discount simply stops applying after the
   * first invoice.
   */
  const coupon = config.coupons[plan.key];
  if (plan.founder && !coupon) throw new Error('BILLING_FOUNDER_COUPON_MISSING');

  const session = await stripeClient(config).checkout.sessions.create(
    {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      ...(coupon ? { discounts: [{ coupon }] } : {}),
      // An existing customer is reused so one account never accumulates two
      // Stripe customers; a first-time buyer is identified by their verified
      // mailbox and Stripe creates the customer.
      ...(request.existingCustomerId
        ? { customer: request.existingCustomerId }
        : { customer_email: request.email }),
      client_reference_id: request.userId,
      metadata,
      // The same metadata on the subscription itself. Every later event — a
      // renewal a year from now — reads the plan and the user from there, so no
      // event ever has to be matched back to an account by email.
      subscription_data: { metadata },
      success_url: `${config.returnOrigin}/settings/subscription?checkout=success`,
      cancel_url: `${config.returnOrigin}/settings/subscription?checkout=cancelled`,
      /*
       * Promotion codes are deliberately off: the only discount in this product
       * is the Founder coupon the server chooses, so there is no field in which
       * a reader could apply one we did not intend.
       *
       * The flag is sent only when no coupon is. Stripe refuses a session
       * carrying both `allow_promotion_codes` and `discounts` — "You may only
       * specify one of these parameters" — so sending it unconditionally made
       * every Founder checkout fail at the provider while ordinary plans, which
       * carry no discount, went through. Omitting it alongside a coupon costs
       * nothing: a session with `discounts` cannot accept a promotion code
       * either way, so the field a reader could type one into does not exist in
       * either branch.
       */
      ...(coupon ? {} : { allow_promotion_codes: false }),
    },
    { idempotencyKey: request.idempotencyKey },
  );

  if (!session.url) throw new Error('BILLING_CHECKOUT_URL_MISSING');
  return { url: session.url, sessionId: session.id };
}

/**
 * Open the provider's own billing portal.
 *
 * Cancellation, payment-method updates and invoice history all live there rather
 * than being rebuilt here — which keeps this product free of any surface that
 * handles a card, and means a cancellation comes back to us as a signed webhook
 * like every other state change.
 */
export async function createStripePortalSession(
  config: BillingConfig,
  customerId: string,
): Promise<string> {
  const session = await stripeClient(config).billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.returnOrigin}/settings/subscription`,
  });
  return session.url;
}

export class BillingSignatureError extends Error {
  constructor() {
    super('BILLING_SIGNATURE_INVALID');
    this.name = 'BillingSignatureError';
  }
}

/**
 * Verify a delivery and turn it into our vocabulary.
 *
 * `constructEventAsync` verifies the HMAC over the **raw** body — which is why
 * the route reads `request.text()` and never `request.json()`; re-serializing
 * JSON changes the bytes and invalidates every signature. It also enforces a
 * timestamp tolerance, so a captured delivery cannot be replayed indefinitely.
 *
 * After verification the subscription is fetched from Stripe rather than read
 * out of the event body. A redelivered event can carry a snapshot that is hours
 * stale; Stripe's current view cannot.
 */
export async function verifyStripeWebhook(
  config: BillingConfig,
  rawBody: string,
  signature: string | null,
): Promise<NormalizedBillingEvent> {
  if (!signature) throw new BillingSignatureError();

  const client = stripeClient(config);
  let event: Stripe.Event;
  try {
    event = await client.webhooks.constructEventAsync(
      rawBody,
      signature,
      config.webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    // The reason is deliberately dropped: a caller who failed verification is
    // told nothing that would help them succeed on the next attempt.
    throw new BillingSignatureError();
  }

  let subscription: Stripe.Subscription | null = null;
  if (classifyStripeEvent(event.type) !== 'ignored') {
    const subscriptionId = subscriptionIdFromEvent(event);
    if (subscriptionId) {
      try {
        subscription = await client.subscriptions.retrieve(subscriptionId);
      } catch {
        // A subscription we cannot read yields an event with no state, which the
        // database routine records and applies nothing from. Failing closed here
        // is what stops a transient API error from clearing someone's plan.
        subscription = null;
      }
    }
  }

  return normalizeStripeEvent(event, subscription);
}
