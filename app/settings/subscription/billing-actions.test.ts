import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getBillingConfig: vi.fn(),
  getBillingAvailability: vi.fn(),
  readBillingSnapshot: vi.fn(),
  readPendingPromptPayPayment: vi.fn(),
  readPromptPaySubscriptionIdentity: vi.fn(),
  recordPendingPromptPayPayment: vi.fn(),
  findStripePromptPayRenewalInvoice: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/src/lib/supabase/server', () => ({ createClient: mocks.createClient }));
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
    readPromptPaySubscriptionIdentity: mocks.readPromptPaySubscriptionIdentity,
    recordPendingPromptPayPayment: mocks.recordPendingPromptPayPayment,
  };
});
vi.mock('@/src/lib/billing/providers/stripe/stripe-provider', () => ({
  findStripePromptPayRenewalInvoice: mocks.findStripePromptPayRenewalInvoice,
}));

import { openPromptPayRenewalAction } from './billing-actions';

const NOW = '2026-08-04T12:00:00.000Z';
const DUE = '2026-08-07T12:00:00.000Z';
const URL = 'https://invoice.stripe.test/i/renewal';

const snapshot = {
  status: 'active',
  billing_plan_key: 'pro_monthly',
  billing_provider_mode: 'test',
  billing_collection_method: 'send_invoice',
  current_period_end: NOW,
  database_now: NOW,
};

const pending = {
  planKey: 'pro_monthly',
  paymentMethod: 'promptpay',
  status: 'awaiting_payment',
  amountBaht: 349,
  hostedInvoiceUrl: URL,
  dueAt: DUE,
  createdAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBillingConfig.mockReturnValue({
    provider: 'stripe',
    providerMode: 'test',
    paymentMethods: ['card', 'promptpay'],
  });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
  });
  mocks.readBillingSnapshot.mockResolvedValue(snapshot);
  mocks.readPendingPromptPayPayment.mockResolvedValue(null);
  mocks.readPromptPaySubscriptionIdentity.mockResolvedValue({
    subscriptionId: 'sub_promptpay',
    planKey: 'pro_monthly',
  });
  mocks.findStripePromptPayRenewalInvoice.mockResolvedValue({
    subscriptionId: 'sub_promptpay',
    invoiceId: 'in_renewal',
    hostedInvoiceUrl: URL,
    dueAt: DUE,
    amountBaht: 349,
  });
  mocks.recordPendingPromptPayPayment.mockResolvedValue('recorded');
});

describe('PromptPay renewal action', () => {
  it('reuses an open pending invoice without another provider read or write', async () => {
    mocks.readPendingPromptPayPayment.mockResolvedValue(pending);

    await expect(openPromptPayRenewalAction()).resolves.toEqual({ ok: true, url: URL });
    expect(mocks.findStripePromptPayRenewalInvoice).not.toHaveBeenCalled();
    expect(mocks.recordPendingPromptPayPayment).not.toHaveBeenCalled();
  });

  it('records only the provider-generated invoice on the existing subscription', async () => {
    await expect(openPromptPayRenewalAction()).resolves.toEqual({ ok: true, url: URL });
    expect(mocks.findStripePromptPayRenewalInvoice).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      subscriptionId: 'sub_promptpay',
    }));
    expect(mocks.recordPendingPromptPayPayment).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      subscriptionId: 'sub_promptpay',
      invoiceId: 'in_renewal',
    }));
  });

  it('fails closed before the paid period ends', async () => {
    mocks.readBillingSnapshot.mockResolvedValue({
      ...snapshot,
      current_period_end: '2026-08-04T12:00:01.000Z',
    });
    const result = await openPromptPayRenewalAction();
    expect(result).toMatchObject({ ok: false, message: 'ชำระได้เมื่อใกล้หมดอายุ' });
    expect(mocks.readPromptPaySubscriptionIdentity).not.toHaveBeenCalled();
    expect(mocks.findStripePromptPayRenewalInvoice).not.toHaveBeenCalled();
    expect(mocks.recordPendingPromptPayPayment).not.toHaveBeenCalled();
  });

  it('contains no optimistic entitlement write path', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'app/settings/subscription/billing-actions.ts',
    ), 'utf8');
    const action = source.slice(
      source.indexOf('export async function openPromptPayRenewalAction'),
      source.indexOf('export async function abandonPromptPayInvoiceAction'),
    );
    expect(action).not.toMatch(/applyBillingEvent|apply_billing_subscription_event|tier\s*=|update\s+public\.user_subscriptions/i);
    expect(action).toContain('recordPendingPromptPayPayment');
  });
});
