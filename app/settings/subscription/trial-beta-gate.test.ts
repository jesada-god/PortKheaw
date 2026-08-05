import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The controlled rollout, applied to the Elite trial.
 *
 * The trial hands out the top plan for seven days, so it is a way *into* the
 * product exactly as a purchase is — and a stage that closes checkout while
 * leaving the trial open closes nothing at all. These tests pin one rule: the
 * same admission answer the plan cards are gated on decides whether the trial
 * may start, and it decides it in the action, where a caller who never touched
 * the button still has to pass.
 *
 * Nothing here starts a real trial: the repository is a mock, and the assertion
 * on every refusal is that it was never constructed.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  resolveRequestAccountAccess: vi.fn(),
  resolveBetaAccessForRequest: vi.fn(),
  startEliteTrial: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/src/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/src/lib/subscription/account-access', () => ({
  resolveRequestAccountAccess: mocks.resolveRequestAccountAccess,
  requireAdmin: vi.fn(),
  setAdminAccessPreview: vi.fn(),
  isAdminRequiredError: () => false,
}));
vi.mock('@/src/lib/subscription/revalidate-entitlements', () => ({
  revalidateEveryEntitlementSurface: vi.fn(),
}));
vi.mock('@/src/lib/beta/beta-server', () => ({
  resolveBetaAccessForRequest: mocks.resolveBetaAccessForRequest,
}));
vi.mock('@/src/lib/subscription/repository', () => ({
  SubscriptionRepository: class {
    startEliteTrial = mocks.startEliteTrial;
  },
}));

import { TRIAL_BETA_BLOCKED_MESSAGE } from '@/src/lib/subscription/trial';
import type { BetaAccess } from '@/src/lib/beta/beta-stages';
import { startEliteTrialAction } from './actions';

/** The exact sentence a blocked reader is shown, on the button and in the action. */
const BLOCKED_COPY = 'ขณะนี้เปิดให้ทดลองเฉพาะผู้ได้รับสิทธิ์เบต้า';

/** The temporary, retryable sentence for a rollout that could not be read. */
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

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.resolveRequestAccountAccess.mockResolvedValue({ isAdmin: false, role: 'user' });
  mocks.resolveBetaAccessForRequest.mockResolvedValue(betaAccess({}));
  mocks.startEliteTrial.mockResolvedValue({
    trialEndsAt: '2026-08-13T00:00:00.000Z',
    trialUsedAt: null,
  });
});

describe('Elite trial under the controlled beta', () => {
  it('refuses a new account while the rollout is closed, without calling the trial routine', async () => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      betaAccess({ stage: 'closed', admitted: false, reason: 'closed_stage', participantCap: 0 }),
    );

    await expect(startEliteTrialAction()).resolves.toEqual({
      ok: false,
      code: 'BETA_NOT_ADMITTED',
      message: BLOCKED_COPY,
    });
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it.each([
    ['beta_5_10' as const, 10],
    ['beta_20_50' as const, 50],
  ])('refuses an uninvited account during %s', async (stage, cap) => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      betaAccess({ stage, admitted: false, reason: 'not_invited', participantCap: cap }),
    );

    const result = await startEliteTrialAction();
    expect(result).toEqual({ ok: false, code: 'BETA_NOT_ADMITTED', message: BLOCKED_COPY });
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it.each([
    ['an invited account in a cohort stage', betaAccess({ stage: 'beta_5_10', reason: 'invited' })],
    ['an account that predates the program', betaAccess({ stage: 'closed', reason: 'pre_existing_account' })],
    ['an account that already subscribes', betaAccess({ stage: 'beta_20_50', reason: 'existing_subscriber' })],
    ['every account once the stage is public', betaAccess({ stage: 'public', reason: 'public_stage' })],
    ['a program the database itself reports as unconfigured', betaAccess({ reason: 'unconfigured' })],
  ])('lets %s start the trial', async (_label, access) => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(access);

    const result = await startEliteTrialAction();
    expect(result.ok).toBe(true);
    expect(mocks.startEliteTrial).toHaveBeenCalledTimes(1);
  });

  /**
   * The third answer: not "in", not "out", but "we could not ask".
   *
   * A trial is spent once per account and cannot be taken back, so an outage of
   * the rollout reader must not be the way somebody gets one. The refusal is
   * retryable and says nothing about admission, because nothing was decided.
   */
  it('refuses when the rollout cannot be read, whatever the stand-in says', async () => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      // The shape of `UNKNOWN_BETA_ACCESS`: admitted, and unresolved.
      betaAccess({ admitted: true, reason: 'unconfigured', resolution: 'unavailable' }),
    );

    await expect(startEliteTrialAction()).resolves.toEqual({
      ok: false,
      code: 'BETA_ACCESS_UNAVAILABLE',
      message: UNRESOLVED_COPY,
    });
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it('tells an unreadable rollout apart from a refusal, in both copy and code', async () => {
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      betaAccess({ stage: 'closed', admitted: false, reason: 'closed_stage', resolution: 'unavailable' }),
    );

    const result = await startEliteTrialAction();
    // Unresolved outranks a refusal read off a stand-in stage: the stage in an
    // unresolved answer was never the program's, so it must not be quoted back.
    expect(result).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE', message: UNRESOLVED_COPY });
    expect(UNRESOLVED_COPY).not.toBe(BLOCKED_COPY);
  });

  it('keeps the administrator refusal ahead of the unreadable rollout', async () => {
    mocks.resolveRequestAccountAccess.mockResolvedValue({ isAdmin: true, role: 'admin' });
    mocks.resolveBetaAccessForRequest.mockResolvedValue(betaAccess({ resolution: 'unavailable' }));

    const result = await startEliteTrialAction();
    expect(result.ok ? '' : result.message).toContain('บัญชีผู้ดูแลระบบ');
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it('keeps the administrator refusal ahead of the rollout refusal', async () => {
    mocks.resolveRequestAccountAccess.mockResolvedValue({ isAdmin: true, role: 'admin' });
    mocks.resolveBetaAccessForRequest.mockResolvedValue(
      betaAccess({ stage: 'closed', admitted: false, reason: 'closed_stage' }),
    );

    const result = await startEliteTrialAction();
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('บัญชีผู้ดูแลระบบ');
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller before the rollout is even asked', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(startEliteTrialAction()).resolves.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(mocks.resolveBetaAccessForRequest).not.toHaveBeenCalled();
    expect(mocks.startEliteTrial).not.toHaveBeenCalled();
  });

  it('gates in the action, not only on the button', () => {
    const action = read('app/settings/subscription/actions.ts');
    const gate = action.indexOf('resolveBetaAccessForRequest()');
    const grant = action.indexOf('startEliteTrial()');
    expect(gate).toBeGreaterThan(-1);
    // The refusal has to be reached before the routine that spends the grant.
    expect(gate).toBeLessThan(grant);
  });

  it('shows the same sentence on the disabled control', () => {
    expect(TRIAL_BETA_BLOCKED_MESSAGE).toBe(BLOCKED_COPY);
    const page = read('app/settings/subscription/page.tsx');
    expect(page).toContain('TRIAL_BETA_BLOCKED_MESSAGE');
    expect(page).toMatch(/trialBlockedReason=\{access\.isAdmin[\s\S]*beta\.admitted/);
  });
});
