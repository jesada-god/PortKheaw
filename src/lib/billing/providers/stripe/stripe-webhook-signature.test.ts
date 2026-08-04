import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BillingConfig } from '../../billing-config';
import { BillingModeMismatchError, BillingSignatureError, verifyStripeWebhook } from './stripe-provider';

/**
 * Signature verification, exercised against the real provider SDK.
 *
 * No credential from any real account is involved: the endpoint secret below is
 * generated in-process for each run, and the signatures are computed here with
 * the documented scheme. What is being tested is that the *verifier* accepts
 * only what that scheme produces.
 *
 * Every event used here is one the adapter classifies as `ignored`, which is
 * what keeps these cases offline — a recognised event would make the adapter
 * fetch the subscription from Stripe. The mapping of recognised events is
 * covered exhaustively in `normalize-stripe-event.test.ts`.
 */

const SECRET = `whsec_${randomBytes(24).toString('hex')}`;

function config(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    provider: 'stripe',
    providerMode: 'test',
    checkoutMode: 'off',
    internalUserIds: [],
    secretKey: `sk_test_${randomBytes(12).toString('hex')}`,
    webhookSecret: SECRET,
    prices: { pro_monthly: 'price_test' },
    coupons: {},
    returnOrigin: 'https://portkheaw.vercel.app',
    ...overrides,
  };
}

/** The documented header: `t=<unix>,v1=<hex hmac of "t.body">`. */
function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_test_1',
    type: 'charge.refunded',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: 'ch_test_1' } },
    ...overrides,
  });
}

describe('webhook signature verification', () => {
  it('accepts a correctly signed delivery', async () => {
    const raw = body();
    const event = await verifyStripeWebhook(config(), raw, sign(raw));
    expect(event.eventId).toBe('evt_test_1');
    expect(event.eventType).toBe('charge.refunded');
    expect(event.provider).toBe('stripe');
    expect(event.providerMode).toBe('test');
  });

  it('rejects a signed live event at a test endpoint before applying it', async () => {
    const raw = body({ livemode: true });
    await expect(verifyStripeWebhook(config(), raw, sign(raw)))
      .rejects.toThrow(BillingModeMismatchError);
  });

  it('refuses a delivery carrying no signature at all', async () => {
    const raw = body();
    await expect(verifyStripeWebhook(config(), raw, null)).rejects.toThrow(BillingSignatureError);
    await expect(verifyStripeWebhook(config(), raw, '')).rejects.toThrow(BillingSignatureError);
  });

  /*
   * The forged-request case. Anyone can POST to this endpoint; only a holder of
   * the endpoint secret can produce a signature over their payload.
   */
  it('refuses a delivery signed with the wrong secret', async () => {
    const raw = body();
    const forged = sign(raw, `whsec_${randomBytes(24).toString('hex')}`);
    await expect(verifyStripeWebhook(config(), raw, forged)).rejects.toThrow(BillingSignatureError);
  });

  /*
   * The tampering case, and the reason the route reads `request.text()` rather
   * than `request.json()`: the HMAC covers the exact bytes delivered.
   */
  it('refuses a body altered after it was signed', async () => {
    const original = body();
    const signature = sign(original);
    const tampered = original.replace('"charge.refunded"', '"customer.subscription.updated"');
    expect(tampered).not.toBe(original);
    await expect(verifyStripeWebhook(config(), tampered, signature)).rejects.toThrow(BillingSignatureError);
  });

  it('refuses a valid signature replayed against a different body', async () => {
    const first = body({ id: 'evt_a' });
    const second = body({ id: 'evt_b' });
    await expect(verifyStripeWebhook(config(), second, sign(first))).rejects.toThrow(BillingSignatureError);
  });

  /*
   * The timestamp tolerance is what stops a delivery captured off the wire from
   * being replayable indefinitely.
   */
  it('refuses a correctly signed delivery that is far too old', async () => {
    const raw = body();
    const ancient = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    await expect(verifyStripeWebhook(config(), raw, sign(raw, SECRET, ancient)))
      .rejects.toThrow(BillingSignatureError);
  });

  it('refuses a malformed signature header', async () => {
    const raw = body();
    for (const header of ['nonsense', 't=,v1=', 'v1=abc', `t=${Math.floor(Date.now() / 1000)}`, '{}']) {
      await expect(verifyStripeWebhook(config(), raw, header), header)
        .rejects.toThrow(BillingSignatureError);
    }
  });

  /*
   * A refusal must not teach the caller how to succeed next time. The error
   * carries a fixed code and nothing about the secret, the expected digest or
   * the tolerance window.
   */
  it('discloses nothing useful in the refusal', async () => {
    const raw = body();
    try {
      await verifyStripeWebhook(config(), raw, sign(raw, 'whsec_wrong_secret_value'));
      expect.unreachable('verification should have failed');
    } catch (error) {
      const text = `${(error as Error).name}${(error as Error).message}${(error as Error).stack ?? ''}`;
      expect((error as Error).message).toBe('BILLING_SIGNATURE_INVALID');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('whsec_wrong_secret_value');
    }
  });

  /*
   * An event outside the lifecycle is verified and understood, but asserts no
   * state — so a refund or a dispute is recorded without rewriting a plan.
   */
  it('normalizes an unrecognised event without asserting entitlement', async () => {
    const raw = body({ type: 'charge.dispute.created' });
    const event = await verifyStripeWebhook(config(), raw, sign(raw));
    expect(event.kind).toBe('ignored');
    expect(event.state).toBeNull();
    expect(event.userId).toBeNull();
  });
});
