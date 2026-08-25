import 'server-only';

import Stripe from 'stripe';
import type { BillingConfig } from '../../billing-config';
import {
  BILLING_METADATA_PLAN_KEY,
  BILLING_METADATA_PROVIDER_MODE,
  BILLING_METADATA_SCHEMA_VERSION,
  BILLING_METADATA_SCHEMA_VERSION_VALUE,
  BILLING_METADATA_USER_ID,
  type NormalizedBillingEvent,
} from '../../billing-events';
import { PROMPTPAY_DUE_DAYS } from '../../billing-payment-method';
import type { BillingPlanDefinition } from '../../billing-plans';
import { stripeLivemode, stripeProviderMode } from '../../billing-provider-mode';
import type { NormalizedRefundEvent } from '../../billing-refunds';
import {
  classifyStripeEvent,
  classifyStripeRefundEvent,
  normalizeStripeEvent,
  normalizeStripeRefundEvent,
  subscriptionIdFromEvent,
  type StripeRefundLinkage,
} from './normalize-stripe-event';

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
 * The identity we stamp on every provider object we create, so that an event a
 * year from now names our account and our plan without being matched by email.
 */
function planMetadata(userId: string, plan: BillingPlanDefinition, config: BillingConfig) {
  return {
    [BILLING_METADATA_USER_ID]: userId,
    [BILLING_METADATA_PLAN_KEY]: plan.key,
    [BILLING_METADATA_PROVIDER_MODE]: config.providerMode,
    [BILLING_METADATA_SCHEMA_VERSION]: BILLING_METADATA_SCHEMA_VERSION_VALUE,
  };
}

/**
 * Read the provider's own Price and Coupon back and refuse to sell if either
 * disagrees with the catalogue.
 *
 * Shared by both rails on purpose. A PromptPay purchase and a card purchase must
 * be the same commercial contract — same Price object, same one-invoice Founder
 * coupon, same currency and cadence — or the two rails would be two products
 * that merely look alike, and the second year of a Founder subscription could
 * quietly bill differently depending on how the first was paid.
 */
async function assertPlanContract(
  client: Stripe,
  config: BillingConfig,
  plan: BillingPlanDefinition,
): Promise<{ priceId: string; coupon: string | undefined }> {
  const priceId = config.prices[plan.key];
  if (!priceId) throw new Error('BILLING_PLAN_NOT_CONFIGURED');
  const coupon = config.coupons[plan.key];
  if (plan.founder && !coupon) throw new Error('BILLING_FOUNDER_COUPON_MISSING');

  const price = await client.prices.retrieve(priceId);
  const expectedLivemode = stripeLivemode(config.providerMode);
  const expectedAmount = plan.renewalBaht * 100;
  if (
    !price.active
    || price.livemode !== expectedLivemode
    || price.currency.toLowerCase() !== plan.currency.toLowerCase()
    || price.unit_amount !== expectedAmount
    || price.recurring?.interval !== plan.interval
  ) throw new Error('BILLING_PRICE_CONTRACT_MISMATCH');

  /*
   * The Founder promotion is a coupon with `duration: once` on top of the
   * ordinary annual price — never a second, cheaper price object. That is what
   * guarantees the second year bills at full rate: the subscription sits on the
   * full price from day one and the discount simply stops applying after the
   * first invoice. On the PromptPay rail this is also what makes the *first* QR
   * the discounted amount and every later one the full one.
   */
  if (coupon) {
    const couponObject = await client.coupons.retrieve(coupon);
    const expectedDiscount = (plan.renewalBaht - plan.firstPeriodBaht) * 100;
    if (
      !couponObject.valid
      || couponObject.livemode !== expectedLivemode
      || couponObject.duration !== 'once'
      || couponObject.currency?.toLowerCase() !== plan.currency.toLowerCase()
      || couponObject.amount_off !== expectedDiscount
      || couponObject.percent_off !== null
    ) throw new Error('BILLING_COUPON_CONTRACT_MISMATCH');
  }

  return { priceId, coupon };
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
  const client = stripeClient(config);
  const { priceId, coupon } = await assertPlanContract(client, config, plan);

  const metadata = planMetadata(request.userId, plan, config);

  const session = await client.checkout.sessions.create(
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

export interface PromptPaySubscriptionRequest {
  config: BillingConfig;
  plan: BillingPlanDefinition;
  userId: string;
  email: string;
  existingCustomerId: string | null;
  idempotencyKey: string;
}

export interface PromptPaySubscriptionResult {
  subscriptionId: string;
  invoiceId: string;
  /** The provider-hosted page that renders the QR. The only URL we hand back. */
  hostedInvoiceUrl: string;
  /** ISO. When the invoice stops being payable. */
  dueAt: string | null;
  /** What this invoice actually asks for, promotion included, in whole baht. */
  amountBaht: number;
}

export interface ExistingPromptPayInvoiceRequest {
  config: BillingConfig;
  userId: string;
  plan: BillingPlanDefinition;
  subscriptionId: string;
}

/**
 * Read the renewal invoice Stripe generated for the existing PromptPay
 * subscription. This function creates and finalizes nothing: before the billing
 * boundary there is no safe invoice to return, and the UI remains disabled.
 */
export async function findStripePromptPayRenewalInvoice(
  request: ExistingPromptPayInvoiceRequest,
): Promise<PromptPaySubscriptionResult | null> {
  const client = stripeClient(request.config);
  const subscription = await client.subscriptions.retrieve(request.subscriptionId, {
    expand: ['latest_invoice'],
  });
  const expectedPrice = request.config.prices[request.plan.key];
  const hasExpectedPrice = subscription.items.data.some((item) => {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    return priceId === expectedPrice;
  });

  if (
    subscription.id !== request.subscriptionId
    || subscription.collection_method !== 'send_invoice'
    || stripeProviderMode(subscription.livemode) !== request.config.providerMode
    || subscription.metadata[BILLING_METADATA_USER_ID] !== request.userId
    || subscription.metadata[BILLING_METADATA_PLAN_KEY] !== request.plan.key
    || subscription.metadata[BILLING_METADATA_PROVIDER_MODE] !== request.config.providerMode
    || !hasExpectedPrice
  ) return null;

  const latest = subscription.latest_invoice;
  if (!latest) return null;
  const invoice = typeof latest === 'string' ? await client.invoices.retrieve(latest) : latest;
  const amountBaht = Math.round((invoice.amount_due ?? invoice.total ?? 0) / 100);
  if (
    invoice.status !== 'open'
    || !invoice.id
    || !invoice.hosted_invoice_url
    || stripeProviderMode(invoice.livemode) !== request.config.providerMode
    || invoice.currency.toLowerCase() !== request.plan.currency.toLowerCase()
    // A Founder coupon has duration `once`; every renewal must be full price.
    || amountBaht !== request.plan.renewalBaht
  ) return null;

  return {
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    dueAt: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
    amountBaht,
  };
}

/**
 * Start a PromptPay purchase.
 *
 * PromptPay is a push payment: the reader scans a QR in their bank's app and the
 * money arrives afterwards. There is no credential to keep and nothing to charge
 * later, so this cannot be a hosted checkout in subscription mode — the provider
 * only supports the rail on a subscription that bills by **invoice**
 * (`collection_method: 'send_invoice'`). That single fact shapes everything
 * here, and two consequences are worth stating rather than discovering:
 *
 *   * The subscription is activated by the provider the moment it is created,
 *     before any money moves. It is therefore **not** evidence of payment, and
 *     `gateEntitlementByCollectionMethod` refuses to open a period from it.
 *     Access begins when a paid invoice says so.
 *
 *   * Nothing renews. Each period issues a fresh invoice and a fresh QR, and if
 *     nobody scans it the paid period simply runs out. That is a product
 *     property the reader is told about before they choose the rail, not a
 *     failure mode to paper over.
 *
 * As on the card rail, the amount is never sent — only a price identifier, with
 * the Founder discount expressed as the same one-invoice coupon.
 */
export async function createStripePromptPaySubscription(
  request: PromptPaySubscriptionRequest,
): Promise<PromptPaySubscriptionResult> {
  const { config, plan } = request;
  const client = stripeClient(config);
  const { priceId, coupon } = await assertPlanContract(client, config, plan);
  const expectedLivemode = stripeLivemode(config.providerMode);
  const metadata = planMetadata(request.userId, plan, config);

  /*
   * One account is one customer. A returning reader keeps the customer their
   * card purchases used, so their invoices stay in one history and the identity
   * checks in the database keep matching.
   */
  const customerId = request.existingCustomerId ?? (await client.customers.create(
    { email: request.email, metadata },
    { idempotencyKey: `${request.idempotencyKey}:customer` },
  )).id;

  const subscription = await client.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: priceId, quantity: 1 }],
      // The rail. Without this the provider would try to charge a payment method
      // that does not exist, and the subscription would never become payable.
      collection_method: 'send_invoice',
      days_until_due: PROMPTPAY_DUE_DAYS,
      payment_settings: {
        payment_method_types: ['promptpay'],
        // Nothing is stored to reuse; PromptPay leaves no reusable credential
        // behind, and saying so keeps the subscription from acquiring a default
        // payment method by a later, unrelated payment.
        save_default_payment_method: 'off',
      },
      ...(coupon ? { discounts: [{ coupon }] } : {}),
      metadata,
      expand: ['latest_invoice'],
    },
    { idempotencyKey: request.idempotencyKey },
  );

  /*
   * Read back what was actually created. If the provider did not put this
   * subscription on the invoice rail, it is an auto-charging subscription with
   * no payment method — refused here rather than left for a reader to discover
   * as a silent failure to renew.
   */
  if (subscription.collection_method !== 'send_invoice') {
    throw new Error('BILLING_PROMPTPAY_COLLECTION_METHOD_MISMATCH');
  }
  if (subscription.livemode !== expectedLivemode) {
    throw new Error('BILLING_PROVIDER_MODE_MISMATCH');
  }

  const invoice = await payableInvoiceFor(client, subscription);
  if (!invoice.id || !invoice.hosted_invoice_url) {
    throw new Error('BILLING_PROMPTPAY_INVOICE_URL_MISSING');
  }

  return {
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    dueAt: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
    // The invoiced amount, not the catalogue's: on a Founder purchase these
    // differ, and the QR the reader scans is for this one.
    amountBaht: Math.round((invoice.amount_due ?? invoice.total ?? 0) / 100),
  };
}

/**
 * The invoice a reader can actually pay.
 *
 * A subscription's first invoice may still be a draft, and a draft has no hosted
 * page and no QR. Finalizing is what publishes it; doing so explicitly means the
 * reader gets a payable link now rather than whenever the provider's own
 * auto-advance happens to run.
 */
async function payableInvoiceFor(
  client: Stripe,
  subscription: Stripe.Subscription,
): Promise<Stripe.Invoice> {
  const latest = subscription.latest_invoice;
  if (!latest) throw new Error('BILLING_PROMPTPAY_INVOICE_MISSING');
  const invoice = typeof latest === 'string' ? await client.invoices.retrieve(latest) : latest;
  if (invoice.status !== 'draft' || !invoice.id) return invoice;
  return client.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
}

/**
 * Abandon an unpaid PromptPay purchase.
 *
 * Somebody who chose the wrong rail should not have to wait three days to pay by
 * card, so this exists — but it is the one operation here that could destroy
 * something valuable, and so it refuses to run on anything that has been paid.
 * The subscription is re-read from the provider first, and a paid invoice or a
 * subscription already collecting normally is left exactly as it is.
 *
 * Cancelling the subscription does not by itself close the invoice, so the open
 * invoice is voided too. Both steps are safe to repeat.
 */
export async function abandonStripePromptPaySubscription(
  config: BillingConfig,
  subscriptionId: string,
): Promise<'abandoned' | 'already-paid'> {
  const client = stripeClient(config);
  const subscription = await client.subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice'],
  });

  if (subscription.collection_method !== 'send_invoice') return 'already-paid';

  const latest = subscription.latest_invoice;
  const invoice = typeof latest === 'string' ? await client.invoices.retrieve(latest) : latest;
  // `paid` is the fact that matters; a paid invoice means money moved and this
  // is no longer an abandonment but a cancellation, which belongs in the portal.
  if (invoice?.status === 'paid') return 'already-paid';

  if (subscription.status !== 'canceled') await client.subscriptions.cancel(subscriptionId);
  if (invoice?.id && invoice.status === 'open') {
    try {
      await client.invoices.voidInvoice(invoice.id);
    } catch {
      // The subscription is already cancelled, so an invoice we could not void
      // can no longer grant anything. It expires on its own at the due date.
    }
  }
  return 'abandoned';
}

/**
 * End a subscription because the account behind it is being deleted.
 *
 * The one thing it must guarantee is that nobody is billed for a product they no
 * longer have an account for. It does **not** refund: money already taken is
 * refunded through the refund-request path a person asks for, on the seven-day
 * window, with a human decision behind it. Deleting an account is not a request
 * for money back, the deletion dialog says so before anything happens, and a
 * pipeline that quietly issued refunds would be moving money nobody asked to
 * move.
 *
 * Safe to repeat: an already-cancelled subscription is a success, not an error,
 * which is what lets the deletion pipeline be retried from any point.
 */
export async function cancelStripeSubscriptionForDeletion(
  config: BillingConfig,
  subscriptionId: string,
): Promise<'canceled' | 'already-canceled'> {
  const client = stripeClient(config);
  const subscription = await client.subscriptions.retrieve(subscriptionId);
  if (subscription.status === 'canceled') return 'already-canceled';
  await client.subscriptions.cancel(subscriptionId);
  return 'canceled';
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

/** Stripe hands back either an id or an expanded object; we only want the id. */
function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

/**
 * The invoice a charge paid.
 *
 * `charge.invoice` no longer exists in this API version — the link moved onto
 * the InvoicePayment object, the same way the invoice's subscription link moved
 * under `parent`. So the route is charge → payment intent → invoice payment →
 * invoice, and a charge that paid no invoice (a one-off, or a payment made
 * outside this product) simply resolves to `null`.
 */
async function invoiceIdForCharge(client: Stripe, charge: Stripe.Charge): Promise<string | null> {
  const paymentIntentId = stripeIdOf(charge.payment_intent);
  if (!paymentIntentId) return null;
  try {
    const payments = await client.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      limit: 1,
    });
    return stripeIdOf(payments.data[0]?.invoice ?? null);
  } catch {
    return null;
  }
}

/**
 * Charge → invoice → subscription, for a refund or a dispute.
 *
 * Every hop is optional and every failure is absorbed. A refund on a charge that
 * has no invoice (a one-off, or a payment from another product on the same
 * account) resolves to a linkage with nulls, which the routine downstream
 * records as a refund event with no entitlement consequence — the honest answer,
 * and the safe one. Nothing here throws, because a lookup that fails must not
 * turn a delivery we could have recorded into a retry loop.
 */
async function resolveRefundLinkage(
  client: Stripe,
  event: Stripe.Event,
): Promise<StripeRefundLinkage> {
  const linkage: StripeRefundLinkage = {
    chargeId: null,
    invoiceId: null,
    subscriptionId: null,
    chargeAmountMinor: null,
  };

  let charge: Stripe.Charge | null = null;
  if (event.type === 'charge.refunded') {
    charge = event.data.object as Stripe.Charge;
  } else {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeId = stripeIdOf(dispute.charge);
    linkage.chargeId = chargeId;
    if (chargeId) {
      try {
        charge = await client.charges.retrieve(chargeId);
      } catch {
        charge = null;
      }
    }
  }

  if (charge) {
    linkage.chargeId = charge.id ?? linkage.chargeId;
    linkage.chargeAmountMinor = typeof charge.amount === 'number' ? charge.amount : null;
    linkage.invoiceId = await invoiceIdForCharge(client, charge);
  }

  if (linkage.invoiceId) {
    try {
      const invoice = await client.invoices.retrieve(linkage.invoiceId);
      // `invoice.subscription` was removed in this API version; the link lives
      // under `parent`, the same place the subscription-event path reads it.
      linkage.subscriptionId = stripeIdOf(invoice.parent?.subscription_details?.subscription ?? null);
    } catch {
      linkage.subscriptionId = null;
    }
  }

  return linkage;
}

export class BillingSignatureError extends Error {
  constructor() {
    super('BILLING_SIGNATURE_INVALID');
    this.name = 'BillingSignatureError';
  }
}

export class BillingModeMismatchError extends Error {
  constructor() {
    super('BILLING_PROVIDER_MODE_MISMATCH');
    this.name = 'BillingModeMismatchError';
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

  const signedEventMode = stripeProviderMode(event.livemode);
  if (signedEventMode !== config.providerMode) throw new BillingModeMismatchError();

  /*
   * A refund or a dispute names a charge, and nothing else. Walking charge →
   * invoice → subscription is what turns it into an event about an account, and
   * it is done here because it is I/O — the classifier that decides what to do
   * about it stays pure.
   */
  const refundLinkage = classifyStripeRefundEvent(event.type)
    ? await resolveRefundLinkage(client, event)
    : null;

  let subscription: Stripe.Subscription | null = null;
  let lookupFailed = false;
  const kind = classifyStripeEvent(event.type);
  const subscriptionId = kind !== 'ignored'
    ? subscriptionIdFromEvent(event)
    : refundLinkage?.subscriptionId ?? null;
  if (subscriptionId) {
    try {
      subscription = await client.subscriptions.retrieve(subscriptionId);
      if (stripeProviderMode(subscription.livemode) !== signedEventMode) {
        throw new BillingModeMismatchError();
      }
    } catch (error) {
      if (error instanceof BillingModeMismatchError) throw error;
      /*
       * A subscription we cannot read is a failure, not an answer. Failing
       * closed here still stops a transient API error from clearing someone's
       * plan — nothing is written — but the delivery is now *flagged* rather
       * than quietly normalized into a stateless event: an event this build
       * would otherwise act on must be retried until the provider answers, and
       * dead-lettered if it never does. Reported only for the kinds that carry
       * entitlement; a refund whose linkage we already resolved does not need
       * the subscription object to reach its own ledger.
       */
      subscription = null;
      lookupFailed = kind !== 'ignored';
    }
  }

  const refund: NormalizedRefundEvent | null = refundLinkage
    ? normalizeStripeRefundEvent(event, refundLinkage)
    : null;

  const normalized = normalizeStripeEvent(event, subscription, refund);
  if (lookupFailed) return { ...normalized, providerLookupFailed: true };
  if (
    normalized.state
    && normalized.planKey
    && normalized.priceId !== config.prices[normalized.planKey]
  ) {
    return { ...normalized, state: null };
  }
  return normalized;
}
