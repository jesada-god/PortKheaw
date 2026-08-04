import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBillingConfig: vi.fn(),
  verifyStripeWebhook: vi.fn(),
  applyBillingEvent: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@/src/lib/billing/billing-server', () => ({ getBillingConfig: mocks.getBillingConfig }));
vi.mock('@/src/lib/billing/billing-repository', () => ({
  applyBillingEvent: mocks.applyBillingEvent,
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

  it('keeps the endpoint closed when provider processing is disabled', async () => {
    mocks.getBillingConfig.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.verifyStripeWebhook).not.toHaveBeenCalled();
    expect(mocks.applyBillingEvent).not.toHaveBeenCalled();
  });
});
