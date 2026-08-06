import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The consent gate on a new purchase.
 *
 * Nothing in this file can create a payment: the provider module is a mock and
 * every refusal is asserted by the provider never having been called. What is
 * being pinned is the order of operations, because the order is the safety
 * property — an unaccepted or stale purchase must be refused *before* the
 * provider SDK is imported, and an accepted one must be written down *before* it
 * is contacted.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  resolveBetaAccessForRequest: vi.fn(),
  consumeRateLimit: vi.fn(),
  getBillingConfig: vi.fn(),
  getBillingAvailability: vi.fn(),
  readBillingSnapshot: vi.fn(),
  readPendingPromptPayPayment: vi.fn(),
  readBillingCustomerId: vi.fn(),
  createStripeCheckoutSession: vi.fn(),
  createStripePromptPaySubscription: vi.fn(),
  recordPendingPromptPayPayment: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/src/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/src/lib/beta/beta-server', () => ({
  resolveBetaAccessForRequest: mocks.resolveBetaAccessForRequest,
  recordBetaFunnelEvent: vi.fn(async () => 'skipped'),
}));
vi.mock('@/src/lib/security/rate-limit', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  rateLimitMessage: () => 'ลองใหม่ภายหลัง',
  resolveClientAddress: async () => null,
}));
vi.mock('@/src/lib/billing/billing-server', () => ({
  getBillingConfig: mocks.getBillingConfig,
  getBillingAvailability: mocks.getBillingAvailability,
}));
vi.mock('@/src/lib/billing/billing-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/billing/billing-repository')>();
  return {
    ...actual,
    readBillingSnapshot: mocks.readBillingSnapshot,
    readPendingPromptPayPayment: mocks.readPendingPromptPayPayment,
    readBillingCustomerId: mocks.readBillingCustomerId,
    recordPendingPromptPayPayment: mocks.recordPendingPromptPayPayment,
  };
});
vi.mock('@/src/lib/billing/providers/stripe/stripe-provider', () => ({
  createStripeCheckoutSession: mocks.createStripeCheckoutSession,
  createStripePromptPaySubscription: mocks.createStripePromptPaySubscription,
  abandonStripePromptPaySubscription: vi.fn(),
  createStripePortalSession: vi.fn(),
  findStripePromptPayRenewalInvoice: vi.fn(),
}));

import {
  PURCHASE_CONSENT_REQUIRED_MESSAGE,
  PURCHASE_CONSENT_STALE_MESSAGE,
  currentPurchasePolicyVersions,
} from '@/src/lib/billing/purchase-consent';
import { startCheckoutAction, openBillingPortalAction } from './billing-actions';

const CURRENT = currentPurchasePolicyVersions();

const CONSENT = {
  accepted: true,
  subscriptionPolicyVersion: CURRENT.subscriptionPolicy,
  refundPolicyVersion: CURRENT.refundPolicy,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [{ consent_id: 'consent-1', outcome: 'recorded' }], error: null });
  mocks.getUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'reader@example.com', email_confirmed_at: '2026-08-01T00:00:00Z' } },
    error: null,
  });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { role: 'user' }, error: null }) }) }),
  });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.resolveBetaAccessForRequest.mockResolvedValue({
    stage: 'public', admitted: true, reason: 'public_stage', isAdmin: false,
    participantCap: -1, activeInvites: 0, resolution: 'resolved',
  });
  mocks.getBillingConfig.mockReturnValue({
    provider: 'stripe', providerMode: 'test', paymentMethods: ['card', 'promptpay'],
  });
  mocks.getBillingAvailability.mockReturnValue({
    enabled: true,
    availablePlanKeys: ['pro_monthly'],
    paymentMethods: ['card', 'promptpay'],
  });
  mocks.readBillingSnapshot.mockResolvedValue({
    status: 'basic',
    billing_plan_key: null,
    billing_provider_mode: 'test',
    billing_collection_method: null,
    current_period_end: null,
    founder_promo_applied: false,
    database_now: '2026-08-06T00:00:00.000Z',
  });
  mocks.readPendingPromptPayPayment.mockResolvedValue(null);
  mocks.readBillingCustomerId.mockResolvedValue(null);
  mocks.createStripeCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.test/c/1' });
});

/** Every provider entry point this action could possibly reach. */
function providerUntouched() {
  expect(mocks.createStripeCheckoutSession).not.toHaveBeenCalled();
  expect(mocks.createStripePromptPaySubscription).not.toHaveBeenCalled();
  expect(mocks.recordPendingPromptPayPayment).not.toHaveBeenCalled();
}

describe('a purchase without an acceptance', () => {
  it('is refused, and nothing payable is created', async () => {
    const result = await startCheckoutAction('pro_monthly', 'card', {
      ...CONSENT,
      accepted: false,
    });
    expect(result).toEqual({
      ok: false,
      code: 'CONSENT_REQUIRED',
      message: PURCHASE_CONSENT_REQUIRED_MESSAGE,
    });
    providerUntouched();
    // Refused before the account is even read, so no consent row is filed for a
    // purchase that never started.
    expect(mocks.readBillingSnapshot).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('is refused when the claim is missing or malformed', async () => {
    for (const claim of [undefined, null, {}, { accepted: true }] as unknown[]) {
      const result = await startCheckoutAction('pro_monthly', 'card', claim as never);
      expect(result).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED' });
    }
    providerUntouched();
  });
});

describe('a purchase accepted against superseded wording', () => {
  it('is refused with the re-read instruction, not treated as agreement', async () => {
    const result = await startCheckoutAction('pro_monthly', 'card', {
      ...CONSENT,
      refundPolicyVersion: '2026-01-01',
    });
    expect(result).toEqual({
      ok: false,
      code: 'CONSENT_STALE',
      message: PURCHASE_CONSENT_STALE_MESSAGE,
    });
    providerUntouched();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  /*
   * A forged version — one that was never published — is the same refusal. The
   * client can echo a version, never choose one.
   */
  it('is refused for a version that was never published', async () => {
    const result = await startCheckoutAction('pro_monthly', 'card', {
      accepted: true,
      subscriptionPolicyVersion: '9999-12-31',
      refundPolicyVersion: '9999-12-31',
    });
    expect(result).toMatchObject({ ok: false, code: 'CONSENT_STALE' });
    providerUntouched();
  });
});

describe('a purchase with a valid acceptance', () => {
  it('records it against the account, then opens the provider’s page', async () => {
    const result = await startCheckoutAction('pro_monthly', 'card', CONSENT);
    expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.test/c/1', paymentMethod: 'card' });

    expect(mocks.rpc).toHaveBeenCalledWith('record_purchase_consent', {
      input_plan_key: 'pro_monthly',
      input_billing_interval: 'month',
      input_payment_rail: 'card',
      input_subscription_policy_version: CURRENT.subscriptionPolicy,
      input_refund_policy_version: CURRENT.refundPolicy,
    });
    // No account identifier is sent: the routine takes it from the session.
    const [, args] = mocks.rpc.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain('user-1');

    // Written before the provider was contacted.
    expect(mocks.rpc.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createStripeCheckoutSession.mock.invocationCallOrder[0]);
  });

  it('records the rail actually chosen', async () => {
    mocks.createStripePromptPaySubscription.mockResolvedValue({
      subscriptionId: 'sub_1', invoiceId: 'in_1',
      hostedInvoiceUrl: 'https://invoice.stripe.test/i/1',
      amountBaht: 349, dueAt: '2026-08-09T00:00:00.000Z',
    });
    mocks.recordPendingPromptPayPayment.mockResolvedValue('recorded');

    const result = await startCheckoutAction('pro_monthly', 'promptpay', CONSENT);
    expect(result).toMatchObject({ ok: true, paymentMethod: 'promptpay' });
    expect(mocks.rpc).toHaveBeenCalledWith('record_purchase_consent', expect.objectContaining({
      input_payment_rail: 'promptpay',
    }));
  });

  /*
   * Fail closed. A checkout that proceeded here would be a charge nobody could
   * later show the buyer agreed to — including on a deployment whose migration
   * has not run yet, which is what the second case is.
   */
  it('is refused when the acceptance cannot be written down', async () => {
    for (const answer of [
      { data: null, error: { code: 'PGRST202', message: 'missing' } },
      { data: [{ consent_id: null, outcome: 'invalid' }], error: null },
    ]) {
      vi.clearAllMocks();
      mocks.rpc.mockResolvedValue(answer);
      const result = await startCheckoutAction('pro_monthly', 'card', CONSENT);
      expect(result).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      providerUntouched();
    }
  });
});

/**
 * The gate is on *new* purchases only. Somebody who already pays must never be
 * locked out of the controls that let them manage or cancel what they bought.
 */
describe('what the gate must not touch', () => {
  it('does not ask the portal for an acceptance', async () => {
    mocks.readBillingCustomerId.mockResolvedValue('cus_1');
    const provider = await import('@/src/lib/billing/providers/stripe/stripe-provider');
    vi.mocked(provider.createStripePortalSession).mockResolvedValue('https://portal.stripe.test/p/1');

    await expect(openBillingPortalAction()).resolves.toEqual({
      ok: true,
      url: 'https://portal.stripe.test/p/1',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
