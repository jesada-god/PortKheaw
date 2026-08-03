import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `server-only` throws on import outside a server component graph. The module
 * under test is server code by construction — the guard is what says so — and
 * stubbing it is how the rest of this suite reaches server modules too.
 */
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/src/lib/supabase/server', () => ({ createClient: mocks.createClient }));

const {
  ANONYMOUS_ACCOUNT_ACCESS,
  AdminRequiredError,
  isAdminRequiredError,
  requireAdmin,
  resolveRequestAccountAccess,
  setAdminAccessPreview,
} = await import('./account-access');
const { resolveRequestEntitlement } = await import('./server-entitlement');

const USER_ID = '52e7b434-1dca-4636-88ab-ea9bdf063761';
const NOW = '2026-08-03T12:00:00.000Z';
const IN_AN_HOUR = '2026-08-03T13:00:00.000Z';

interface AccessRowOverrides {
  role?: string;
  preview_mode?: string;
  preview_expires_at?: string | null;
  tier?: string;
  status?: string;
  trial_ends_at?: string | null;
  trial_used_at?: string | null;
  current_period_end?: string | null;
}

function accessRow(overrides: AccessRowOverrides = {}) {
  return {
    user_id: USER_ID,
    role: 'user',
    preview_mode: 'actual',
    preview_expires_at: null,
    tier: 'basic',
    status: 'basic',
    trial_ends_at: null,
    trial_used_at: null,
    current_period_end: null,
    database_now: NOW,
    ...overrides,
  };
}

function client({ user = { id: USER_ID }, rpc }: {
  user?: { id: string } | null;
  rpc?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: user ? null : new Error('no session') }) },
    rpc: rpc ?? vi.fn().mockResolvedValue({ data: [accessRow()], error: null }),
  };
}

beforeEach(() => {
  mocks.createClient.mockReset();
});

describe('resolveRequestAccountAccess', () => {
  it('resolves an ordinary reader to their own subscription and no role', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({
        data: [accessRow({ tier: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z' })],
        error: null,
      }),
    }));

    const access = await resolveRequestAccountAccess();
    expect(access.authenticated).toBe(true);
    expect(access.role).toBe('user');
    expect(access.isAdmin).toBe(false);
    expect(access.subscriptionEffectiveTier).toBe('pro');
    expect(access.effectiveAccessTier).toBe('pro');
    expect(access.adminPreviewMode).toBe('actual');
  });

  it('gives an administrator Elite access while reporting the plan they hold', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({ data: [accessRow({ role: 'admin' })], error: null }),
    }));

    const access = await resolveRequestAccountAccess();
    expect(access.isAdmin).toBe(true);
    expect(access.effectiveAccessTier).toBe('elite');
    expect(access.subscriptionEffectiveTier).toBe('basic');
    expect(access.storedTier).toBe('basic');
    expect(access.status).toBe('basic');
  });

  it('applies a running preview to access only, never to the stored plan', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({
        data: [accessRow({
          role: 'admin',
          preview_mode: 'basic',
          preview_expires_at: IN_AN_HOUR,
          tier: 'elite',
          status: 'active',
          current_period_end: '2099-01-01T00:00:00.000Z',
        })],
        error: null,
      }),
    }));

    const access = await resolveRequestAccountAccess();
    expect(access.effectiveAccessTier).toBe('basic');
    expect(access.adminPreviewMode).toBe('basic');
    expect(access.previewExpiresAt).toBe(IN_AN_HOUR);
    // Still Elite on paper, and still an administrator.
    expect(access.subscriptionEffectiveTier).toBe('elite');
    expect(access.storedTier).toBe('elite');
    expect(access.isAdmin).toBe(true);
  });

  it('carries no billing identifier of any kind', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({ data: [accessRow({ role: 'admin' })], error: null }),
    }));
    const access = await resolveRequestAccountAccess();
    expect(JSON.stringify(access)).not.toMatch(/billing|customer|price|subscription_id/i);
  });

  it('sends no arguments to the resolver RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [accessRow()], error: null });
    mocks.createClient.mockResolvedValue(client({ rpc }));
    await resolveRequestAccountAccess();
    expect(rpc).toHaveBeenCalledWith('get_my_account_access');
    expect(rpc.mock.calls[0]).toHaveLength(1);
  });

  it('falls closed to a signed-in Basic reader when the resolver cannot be read', async () => {
    for (const failure of [
      { data: null, error: new Error('boom') },
      { data: [], error: null },
      { data: null, error: null },
    ]) {
      mocks.createClient.mockResolvedValue(client({ rpc: vi.fn().mockResolvedValue(failure) }));
      const access = await resolveRequestAccountAccess();
      expect(access.authenticated).toBe(true);
      expect(access.role).toBe('user');
      expect(access.isAdmin).toBe(false);
      expect(access.effectiveAccessTier).toBe('basic');
    }
  });

  it('falls closed to anonymous with no session and no Supabase', async () => {
    mocks.createClient.mockResolvedValue(client({ user: null }));
    expect(await resolveRequestAccountAccess()).toEqual(ANONYMOUS_ACCOUNT_ACCESS);

    mocks.createClient.mockResolvedValue(null);
    expect(await resolveRequestAccountAccess()).toEqual(ANONYMOUS_ACCOUNT_ACCESS);
    expect(ANONYMOUS_ACCOUNT_ACCESS.isAdmin).toBe(false);
    expect(ANONYMOUS_ACCOUNT_ACCESS.effectiveAccessTier).toBe('basic');
  });
});

describe('resolveRequestEntitlement', () => {
  it('gates API routes on the effective access tier, so a preview refuses what it should', async () => {
    const cases = [
      { row: accessRow({ role: 'admin' }), tier: 'elite' },
      { row: accessRow({ role: 'admin', preview_mode: 'basic', preview_expires_at: IN_AN_HOUR }), tier: 'basic' },
      { row: accessRow({ role: 'admin', preview_mode: 'pro', preview_expires_at: IN_AN_HOUR }), tier: 'pro' },
      { row: accessRow({ role: 'admin', preview_mode: 'elite_trial', preview_expires_at: IN_AN_HOUR }), tier: 'elite' },
      { row: accessRow({ role: 'admin', preview_mode: 'expired_trial', preview_expires_at: IN_AN_HOUR }), tier: 'basic' },
      // A lapsed preview is already gone at the database, but the resolver
      // refuses to honour one either way.
      { row: accessRow({ role: 'admin', preview_mode: 'basic', preview_expires_at: '2026-08-03T11:00:00.000Z' }), tier: 'elite' },
    ] as const;

    for (const { row, tier } of cases) {
      mocks.createClient.mockResolvedValue(client({ rpc: vi.fn().mockResolvedValue({ data: [row], error: null }) }));
      const entitlement = await resolveRequestEntitlement();
      expect(`${row.preview_mode}=${entitlement.tier}`).toBe(`${row.preview_mode}=${tier}`);
      expect(entitlement.authenticated).toBe(true);
    }
  });
});

describe('requireAdmin', () => {
  it('passes inside a Basic preview, because it reads the stored role', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({
        data: [accessRow({ role: 'admin', preview_mode: 'basic', preview_expires_at: IN_AN_HOUR })],
        error: null,
      }),
    }));
    const access = await requireAdmin();
    expect(access.isAdmin).toBe(true);
    expect(access.effectiveAccessTier).toBe('basic');
  });

  it('refuses an ordinary reader, an anonymous caller and an unreadable resolver', async () => {
    for (const setup of [
      client(),
      client({ user: null }),
      client({ rpc: vi.fn().mockResolvedValue({ data: null, error: new Error('boom') }) }),
    ]) {
      mocks.createClient.mockResolvedValue(setup);
      await expect(requireAdmin()).rejects.toBeInstanceOf(AdminRequiredError);
    }
  });
});

describe('isAdminRequiredError', () => {
  it('recognises both the local guard and the database refusal', () => {
    expect(isAdminRequiredError(new AdminRequiredError())).toBe(true);
    expect(isAdminRequiredError({ message: 'ADMIN_REQUIRED' })).toBe(true);
    expect(isAdminRequiredError({ message: 'permission denied' })).toBe(false);
    expect(isAdminRequiredError(null)).toBe(false);
  });
});

describe('setAdminAccessPreview', () => {
  it('sends only the mode, and never a user id or an expiry the client chose', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ mode: 'pro', expires_at: IN_AN_HOUR, database_now: NOW }],
      error: null,
    });
    mocks.createClient.mockResolvedValue(client({ rpc }));

    const grant = await setAdminAccessPreview('pro');
    expect(rpc).toHaveBeenCalledWith('set_my_admin_access_preview', { input_mode: 'pro' });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain(USER_ID);
    expect(grant).toEqual({ mode: 'pro', expiresAt: IN_AN_HOUR, databaseNow: NOW });
  });

  it('surfaces the database refusal unchanged so the caller can map it', async () => {
    mocks.createClient.mockResolvedValue(client({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'ADMIN_REQUIRED' } }),
    }));
    await expect(setAdminAccessPreview('elite')).rejects.toMatchObject({ message: 'ADMIN_REQUIRED' });
  });
});
