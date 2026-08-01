import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  evaluateEnabledAlerts: vi.fn(),
  getMarketDataProvider: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));
vi.mock('@/src/lib/alerts/evaluation', () => ({
  evaluateEnabledAlerts: mocks.evaluateEnabledAlerts,
}));
vi.mock('@/src/lib/market-data', () => ({
  getMarketDataProvider: mocks.getMarketDataProvider,
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
    mocks.getMarketDataProvider.mockReturnValue({});
    mocks.evaluateEnabledAlerts.mockResolvedValue({
      evaluated: 1,
      triggered: 0,
      unavailable: [],
    });
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
    expect(mocks.evaluateEnabledAlerts).not.toHaveBeenCalled();
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
    expect(mocks.evaluateEnabledAlerts).not.toHaveBeenCalled();
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
    expect(mocks.evaluateEnabledAlerts).not.toHaveBeenCalled();
  });
});
