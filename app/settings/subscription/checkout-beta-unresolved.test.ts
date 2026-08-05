import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A new purchase when the controlled rollout cannot be read.
 *
 * The rollout answer has three states, not two: admitted, refused, and absent.
 * Only the first may start a purchase. These tests pin that the absent case is
 * refused *before* anything is looked up — no snapshot read, no provider SDK, no
 * invoice — and that it is refused with its own retryable code rather than being
 * dressed up as a waitlist refusal, which would tell a reader they are excluded
 * from a program that never answered.
 *
 * Nothing here can create a payment: the billing repository and the provider are
 * mocks, and every assertion on a refusal is that they were never called.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  resolveBetaAccessForRequest: vi.fn(),
  consumeRateLimit: vi.fn(),
  getBillingConfig: vi.fn(),
  getBillingAvailability: vi.fn(),
  readBillingSnapshot: vi.fn(),
  readPendingPromptPayPayment: vi.fn(),
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
  };
});

import { BETA_ACCESS_UNAVAILABLE_MESSAGE, type BetaAccess } from '@/src/lib/beta/beta-stages';
import { startCheckoutAction } from './billing-actions';

/** The exact sentence, asserted literally so a copy change cannot pass silently. */
const UNRESOLVED_COPY = 'ไม่สามารถตรวจสอบสิทธิ์การเข้าร่วมได้ชั่วคราว กรุณาลองใหม่อีกครั้ง';

function betaAccess(overrides: Partial<BetaAccess>): BetaAccess {
  return {
    stage: 'public',
    admitted: true,
    reason: 'public_stage',
    isAdmin: false,
    participantCap: -1,
    activeInvites: 0,
    resolution: 'resolved',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email_confirmed_at: '2026-08-01T00:00:00Z' } }, error: null });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { role: 'user' }, error: null }) }) }),
  });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.resolveBetaAccessForRequest.mockResolvedValue(betaAccess({}));
  mocks.getBillingConfig.mockReturnValue({
    provider: 'stripe',
    providerMode: 'test',
    paymentMethods: ['card', 'promptpay'],
  });
  mocks.getBillingAvailability.mockReturnValue({
    enabled: true,
    availablePlanKeys: ['pro_monthly'],
    paymentMethods: ['card'],
  });
  mocks.readBillingSnapshot.mockResolvedValue(null);
  mocks.readPendingPromptPayPayment.mockResolvedValue(null);
});

describe('new checkout when beta access cannot be resolved', () => {
  it('refuses with the retryable code before reading anything about the account', async () => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      // The shape of `UNKNOWN_BETA_ACCESS`: admitted, and unresolved.
      betaAccess({ admitted: true, reason: 'unconfigured', resolution: 'unavailable' }),
    );

    await expect(startCheckoutAction('pro_monthly', 'card')).resolves.toEqual({
      ok: false,
      code: 'BETA_ACCESS_UNAVAILABLE',
      message: UNRESOLVED_COPY,
    });
    expect(mocks.readBillingSnapshot).not.toHaveBeenCalled();
    expect(mocks.readPendingPromptPayPayment).not.toHaveBeenCalled();
  });

  it('says the same sentence the trial says, from the one shared constant', () => {
    expect(BETA_ACCESS_UNAVAILABLE_MESSAGE).toBe(UNRESOLVED_COPY);
  });

  it('does not quote the stand-in stage back as a waitlist refusal', async () => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      betaAccess({ stage: 'closed', admitted: false, reason: 'closed_stage', resolution: 'unavailable' }),
    );

    const result = await startCheckoutAction('pro_monthly', 'card');
    expect(result).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE', message: UNRESOLVED_COPY });
  });

  it('still lets a resolved admission through to the eligibility gate', async () => {
    const result = await startCheckoutAction('pro_monthly', 'card');

    // Whatever the deployment's own billing answer is, it is not the rollout's:
    // a resolved admission must reach the code that reads the account.
    expect(result.ok ? '' : result.code).not.toBe('BETA_ACCESS_UNAVAILABLE');
    expect(mocks.readBillingSnapshot).toHaveBeenCalled();
  });
});
