import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
  This route ACCEPTS, it does not evaluate.

  It used to mock `@/src/lib/alerts/evaluation` and assert the evaluator was
  never called — a guard against browser-driven polling coming back. That module
  is deleted (`202609200001` dropped the RPC behind it), so the guard is now that
  the route imports nothing capable of evaluating at all, which the assertion
  below states directly against the response.
*/
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

import { POST } from './route';

function authClient(result: unknown) {
  return {
    auth: {
      getUser: vi.fn(async () => result),
    },
  };
}

describe('POST /api/alerts/evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authenticates the cookie-bound user without starting browser-driven polling', async () => {
    mocks.createClient.mockResolvedValue(
      authClient({
        data: { user: { id: 'user-1' } },
        error: null,
      }),
    );

    const response = await POST();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: {
        scheduled: true,
        message: 'ระบบจะตรวจราคาเป้าหมายตามรอบอัตโนมัติ',
      },
    });
  });

  it('returns 401 and a structured safe log for an invalid session', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.createClient.mockResolvedValue(
      authClient({
        data: { user: null },
        error: Object.assign(new Error('Invalid Refresh Token'), {
          code: 'refresh_token_not_found',
          status: 400,
          access_token: 'must-not-appear-in-logs',
        }),
      }),
    );

    const response = await POST();
    const entry = JSON.parse(String(log.mock.calls[0]?.[0]));

    expect(response.status).toBe(401);
    expect(entry).toEqual({
      event: 'alert_evaluation_auth_failed',
      message: 'Invalid Refresh Token',
      code: 'refresh_token_not_found',
      status: 400,
    });
    expect(JSON.stringify(entry)).not.toContain(
      'must-not-appear-in-logs',
    );
  });

  it('returns 401 when no authenticated user is present', async () => {
    mocks.createClient.mockResolvedValue(
      authClient({
        data: { user: null },
        error: null,
      }),
    );

    const response = await POST();

    expect(response.status).toBe(401);
  });
});
