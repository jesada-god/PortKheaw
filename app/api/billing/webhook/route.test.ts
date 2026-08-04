import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBillingConfig: vi.fn(),
  verifyStripeWebhook: vi.fn(),
  applyBillingEvent: vi.fn(),
  applyBillingPaymentRail: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@/src/lib/billing/billing-server', () => ({ getBillingConfig: mocks.getBillingConfig }));
vi.mock('@/src/lib/billing/billing-repository', () => ({
  applyBillingEvent: mocks.applyBillingEvent,
  applyBillingPaymentRail: mocks.applyBillingPaymentRail,
  BillingAdminUnavailableError: class BillingAdminUnavailableError extends Error {},
}));
vi.mock('@/src/lib/billing/providers/stripe/stripe-provider', () => ({
  verifyStripeWebhook: mocks.verifyStripeWebhook,
  BillingSignatureError: class BillingSignatureError extends Error {},
  BillingModeMismatchError: class BillingModeMismatchError extends Error {},
}));
vi.mock('@/src/lib/subscription/revalidate-entitlements', () => ({
  revalidateEveryEntitlementSurface: mocks.revalidate,
}));

const { POST } = await import('./route');
const { BillingModeMismatchError, BillingSignatureError } = await import(
  '@/src/lib/billing/providers/stripe/stripe-provider'
);

function request(): Request {
  return new Request('https://portkheaw.vercel.app/api/billing/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'signed-fixture' },
    body: '{"id":"evt_fixture"}',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBillingConfig.mockReturnValue({ providerMode: 'live' });
  mocks.applyBillingPaymentRail.mockResolvedValue({ railUpdated: true, pendingCleared: true });
});

describe('billing webhook route isolation', () => {
  it('rejects a signed mode mismatch without touching billing state', async () => {
    mocks.verifyStripeWebhook.mockRejectedValue(new BillingModeMismatchError());
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'mode_mismatch' });
    expect(mocks.applyBillingEvent).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature without touching billing state', async () => {
    mocks.verifyStripeWebhook.mockRejectedValue(new BillingSignatureError());
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_signature' });
    expect(mocks.applyBillingEvent).not.toHaveBeenCalled();
  });

  it('applies and revalidates only a verified, mode-matched event', async () => {
    const event = { eventType: 'customer.subscription.updated', providerMode: 'live' };
    mocks.verifyStripeWebhook.mockResolvedValue(event);
    mocks.applyBillingEvent.mockResolvedValue('applied');
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: 'applied' });
    expect(mocks.applyBillingEvent).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  /*
   * The PromptPay rail's settlement, which runs beside the entitlement write
   * rather than inside it: it records which rail the subscription is on and
   * closes an invoice that has been settled, and it can grant nothing.
   */
  describe('settling a purchase that was in flight', () => {
    const promptPayEvent = (kind: string) => ({
      eventType: 'invoice.paid',
      providerMode: 'live' as const,
      kind,
      userId: 'user-1',
      subscriptionId: 'sub_1',
      collectionMethod: 'send_invoice' as const,
    });

    it.each(['payment_succeeded', 'invoice_closed', 'subscription_canceled'])(
      'closes the pending invoice on %s',
      async (kind) => {
        mocks.verifyStripeWebhook.mockResolvedValue(promptPayEvent(kind));
        mocks.applyBillingEvent.mockResolvedValue('applied');

        await POST(request());

        expect(mocks.applyBillingPaymentRail).toHaveBeenCalledWith({
          userId: 'user-1',
          providerMode: 'live',
          subscriptionId: 'sub_1',
          collectionMethod: 'send_invoice',
          pendingSettled: true,
        });
      },
    );

    /*
     * A failed payment leaves the invoice open: on this rail the reader can
     * still scan again before the due date, and clearing the row would take
     * their QR away while the invoice is still live.
     */
    it('leaves the invoice open when a payment merely failed', async () => {
      mocks.verifyStripeWebhook.mockResolvedValue(promptPayEvent('payment_failed'));
      mocks.applyBillingEvent.mockResolvedValue('applied');

      await POST(request());

      expect(mocks.applyBillingPaymentRail).toHaveBeenCalledWith(
        expect.objectContaining({ pendingSettled: false }),
      );
    });

    /*
     * A redelivery the database answered as a duplicate must still settle: the
     * first attempt may have failed after the entitlement write.
     */
    it('settles even when the event itself was a duplicate', async () => {
      mocks.verifyStripeWebhook.mockResolvedValue(promptPayEvent('payment_succeeded'));
      mocks.applyBillingEvent.mockResolvedValue('duplicate');

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mocks.applyBillingPaymentRail).toHaveBeenCalledOnce();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    });

    it('does nothing at all for an event that names no account', async () => {
      mocks.verifyStripeWebhook.mockResolvedValue({
        eventType: 'charge.refunded', providerMode: 'live', kind: 'ignored',
        userId: null, subscriptionId: null, collectionMethod: null,
      });
      mocks.applyBillingEvent.mockResolvedValue('ignored');

      await POST(request());

      expect(mocks.applyBillingPaymentRail).not.toHaveBeenCalled();
    });
  });

  it('keeps the endpoint closed when provider processing is disabled', async () => {
    mocks.getBillingConfig.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.verifyStripeWebhook).not.toHaveBeenCalled();
    expect(mocks.applyBillingEvent).not.toHaveBeenCalled();
  });
});
