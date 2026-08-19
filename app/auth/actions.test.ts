import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_AUTH_STATE, type AuthFormState } from '@/src/lib/auth/form-state';

/*
 * Nothing in this file waits on a timer or a network — the Supabase client is a
 * recorder and every assertion is synchronous once the module is in memory. What
 * IS slow is the `await import('./actions')` in `beforeEach`, which pulls the
 * server-action module graph in, and under a full-suite run that competes with
 * every other worker for CPU. It measured 2.8s alone and intermittently crossed
 * the 5s default when the whole suite ran, which read as a flake in a test that
 * has nothing flaky in it.
 *
 * A longer ceiling, not a retry: a retry would hide a real hang, while this only
 * costs anything on a run that was going to be slow regardless.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Behaviour tests for the authentication server actions.
 *
 * The Supabase client is replaced with a recorder, not with a re-implementation:
 * every assertion below is about what *this* code does with a given provider
 * answer — which call it makes, what it refuses to do, and exactly what it tells
 * the visitor. The provider answers used here are the ones measured against the
 * real project with `npm run probe:auth-recovery`.
 */

class RedirectError extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new RedirectError(target);
  },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://portkheaw.app' }),
}));

let client: FakeClient | null = null;

vi.mock('@/src/lib/supabase/server', () => ({
  createClient: async () => client,
}));

interface AuthAnswer {
  data?: unknown;
  error?: { code?: string; status?: number; message?: string; name?: string } | null;
}

class FakeClient {
  calls: { method: string; args: unknown[] }[] = [];
  answers: Record<string, AuthAnswer> = {};

  private record(method: string, args: unknown[]): AuthAnswer {
    this.calls.push({ method, args });
    return this.answers[method] ?? { data: null, error: null };
  }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  auth = {
    signInWithPassword: async (...args: unknown[]) => this.record('signInWithPassword', args) as never,
    signUp: async (...args: unknown[]) => this.record('signUp', args) as never,
    resetPasswordForEmail: async (...args: unknown[]) => this.record('resetPasswordForEmail', args) as never,
    updateUser: async (...args: unknown[]) => this.record('updateUser', args) as never,
    signOut: async (...args: unknown[]) => this.record('signOut', args) as never,
    getUser: async () => (this.record('getUser', []) as { data: { user: unknown } }),
    getClaims: async () => (this.record('getClaims', []) as { data: { claims: unknown } | null }),
  };

  rpc = async (...args: unknown[]) => this.record('rpc', args) as never;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  Object.entries(entries).forEach(([key, value]) => data.set(key, value));
  return data;
}

/** Runs an action, returning either the state it produced or the path it redirected to. */
async function run(
  action: (state: AuthFormState, data: FormData) => Promise<AuthFormState>,
  data: FormData,
): Promise<{ state?: AuthFormState; redirectedTo?: string }> {
  try {
    return { state: await action(IDLE_AUTH_STATE, data) };
  } catch (error) {
    if (error instanceof RedirectError) return { redirectedTo: error.target };
    throw error;
  }
}

const PASSWORD_USER = { id: 'user-1', email: 'someone@example.com', identities: [{ provider: 'email' }] };
const GOOGLE_ONLY_USER = { id: 'user-2', email: 'someone@gmail.com', identities: [{ provider: 'google' }] };
/** Measured: a session minted from a recovery link. */
const RECOVERY_CLAIMS = { data: { claims: { amr: [{ method: 'otp', timestamp: 1785439612 }] } } };
/** Measured: an ordinary password sign-in. */
const PASSWORD_CLAIMS = { data: { claims: { amr: [{ method: 'password', timestamp: 1785439691 }] } } };

let actions: typeof import('./actions');

beforeEach(async () => {
  client = new FakeClient();
  actions = await import('./actions');
});

describe('signInAction', () => {
  it('signs in and returns to the path the visitor was originally heading for', async () => {
    const result = await run(actions.signInAction, form({
      email: 'someone@example.com',
      password: 'PortKheaw#2026',
      next: '/portfolio',
    }));
    expect(result.redirectedTo).toBe('/portfolio');
    expect(client!.countOf('signInWithPassword')).toBe(1);
  });

  it('never redirects off this origin, whatever the return path claims', async () => {
    for (const hostile of ['//evil.com', 'https://evil.com/steal', '/\\evil.com', '/%2F%2Fevil.com', '\\\\evil.com']) {
      client = new FakeClient();
      const result = await run(actions.signInAction, form({
        email: 'someone@example.com',
        password: 'PortKheaw#2026',
        next: hostile,
      }));
      // The percent-encoded form legitimately survives as an encoded path
      // segment; what matters is where a browser would actually go.
      expect(new URL(result.redirectedTo!, 'https://portkheaw.app').origin).toBe('https://portkheaw.app');
      expect(result.redirectedTo!.startsWith('/')).toBe(true);
    }
  });

  it('keeps the typed address and shows one indistinguishable message on bad credentials', async () => {
    client!.answers.signInWithPassword = {
      data: null,
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    };
    const { state } = await run(actions.signInAction, form({
      email: 'someone@example.com',
      password: 'wrong-password',
      next: '/watchlist',
    }));
    expect(state?.status).toBe('error');
    expect(state?.message).toBe('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    expect(state?.values?.email).toBe('someone@example.com');
    // The password is never echoed back into the form state.
    expect(JSON.stringify(state)).not.toContain('wrong-password');
    // Nor is the provider's own English sentence.
    expect(JSON.stringify(state)).not.toContain('Invalid login credentials');
  });

  it('rejects a malformed address before it ever reaches the provider', async () => {
    const { state } = await run(actions.signInAction, form({ email: 'not-an-email', password: 'PortKheaw#2026' }));
    expect(state?.fieldErrors?.email).toBeTruthy();
    expect(client!.countOf('signInWithPassword')).toBe(0);
  });

  it('does not apply the new password policy to existing accounts', async () => {
    // An account created years ago may hold a short password; sign-in must not
    // start refusing it locally.
    await run(actions.signInAction, form({ email: 'someone@example.com', password: 'old' }));
    expect(client!.countOf('signInWithPassword')).toBe(1);
  });
});

describe('signUpAction', () => {
  it('creates the account and shows the verification state, never a signed-in redirect', async () => {
    // Measured shape: confirmation required, so there is no session yet.
    client!.answers.signUp = { data: { user: { id: 'new-user', identities: [{ provider: 'email' }] }, session: null }, error: null };
    const { state, redirectedTo } = await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'new@example.com',
      password: 'PortKheaw#2026',
    }));
    expect(redirectedTo).toBeUndefined();
    expect(state?.status).toBe('verification-sent');
    expect(state?.email).toBe('new@example.com');
  });

  it('answers an address that already has a Google-only account exactly as it answers a new one', async () => {
    // Measured: Supabase returns a placeholder user with no identities and no
    // session for an address that already exists. No second user is created and
    // no password identity is added — and the screen must not reveal any of it.
    client!.answers.signUp = { data: { user: { id: 'placeholder', identities: [] }, session: null }, error: null };
    const existing = await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'google-user@gmail.com',
      password: 'PortKheaw#2026',
    }));

    client = new FakeClient();
    client.answers.signUp = { data: { user: { id: 'brand-new', identities: [{ provider: 'email' }] }, session: null }, error: null };
    const fresh = await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'brand-new@example.com',
      password: 'PortKheaw#2026',
    }));

    expect(existing.state?.status).toBe(fresh.state?.status);
    expect(existing.state?.message).toBe(fresh.state?.message);
    expect(existing.state?.status).toBe('verification-sent');
  });

  it('never calls anything that could attach a password to an existing account', async () => {
    client!.answers.signUp = { data: { user: { id: 'placeholder', identities: [] }, session: null }, error: null };
    await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'google-user@gmail.com',
      password: 'PortKheaw#2026',
    }));
    expect(client!.countOf('updateUser')).toBe(0);
    expect(client!.countOf('signUp')).toBe(1);
    /*
     * The only routine sign-up is allowed to call is the rate limiter, which
     * takes a bucket digest and nothing else. Asserting *which* routines ran is
     * the point rather than asserting none did: an action that could link an
     * identity, set a password or promote an account would show up here by name.
     */
    const routines = client!.calls
      .filter((call) => call.method === 'rpc')
      .map((call) => call.args[0]);
    expect(new Set(routines)).toEqual(new Set(['consume_rate_limit']));
  });

  it('enforces the same password policy the checklist displays', async () => {
    for (const weak of ['short1!', 'portkheaw1!', 'PortKheaw!', 'PortKheaw12']) {
      client = new FakeClient();
      const { state } = await run(actions.signUpAction, form({
        fullName: 'เจษฎา',
        email: 'new@example.com',
        password: weak,
      }));
      expect(state?.fieldErrors?.password).toBeTruthy();
      expect(client.countOf('signUp')).toBe(0);
    }
  });

  it('sends the confirmation link back to this origin, not to anything in the form', async () => {
    client!.answers.signUp = { data: { user: { id: 'u' }, session: null }, error: null };
    await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'new@example.com',
      password: 'PortKheaw#2026',
      next: 'https://evil.com/harvest',
    }));
    const options = (client!.calls.find((call) => call.method === 'signUp')?.args[0] as {
      options: { emailRedirectTo: string };
    }).options;
    expect(options.emailRedirectTo.startsWith('https://portkheaw.app/auth/callback')).toBe(true);
    expect(options.emailRedirectTo).not.toContain('evil.com');
  });

  it('keeps the name and address on the form when the provider rejects the attempt', async () => {
    client!.answers.signUp = { data: null, error: { code: 'unexpected_failure', status: 500, message: 'Database error saving new user' } };
    const { state } = await run(actions.signUpAction, form({
      fullName: 'เจษฎา',
      email: 'new@example.com',
      password: 'PortKheaw#2026',
    }));
    expect(state?.values).toEqual({ fullName: 'เจษฎา', email: 'new@example.com' });
    expect(state?.message).not.toContain('Database');
  });
});

describe('forgotPasswordAction', () => {
  it('answers identically for an unknown address, a password account and a Google-only account', async () => {
    const answers: AuthAnswer[] = [
      { data: {}, error: null },
      { data: {}, error: { code: 'user_not_found', status: 404, message: 'User not found' } },
    ];
    const states: (AuthFormState | undefined)[] = [];
    for (const answer of answers) {
      client = new FakeClient();
      client.answers.resetPasswordForEmail = answer;
      const { state } = await run(actions.forgotPasswordAction, form({ email: 'someone@example.com' }));
      states.push(state);
    }
    expect(states[0]?.status).toBe('recovery-sent');
    expect(states[0]?.status).toBe(states[1]?.status);
    expect(states[0]?.message).toBe(states[1]?.message);
  });

  it('points the recovery link at this origin, never at a supplied URL', async () => {
    await run(actions.forgotPasswordAction, form({ email: 'someone@example.com' }));
    const options = client!.calls.find((call) => call.method === 'resetPasswordForEmail')?.args[1] as { redirectTo: string };
    expect(options.redirectTo).toBe('https://portkheaw.app/auth/callback?next=%2Fauth%2Freset-password');
  });

  it('surfaces rate limiting, which is about this visitor, not about who has an account', async () => {
    client!.answers.resetPasswordForEmail = { data: null, error: { code: 'over_email_send_rate_limit', status: 429 } };
    const { state } = await run(actions.forgotPasswordAction, form({ email: 'someone@example.com' }));
    expect(state?.status).toBe('error');
    expect(state?.message).toContain('ถี่เกินไป');
  });

  it('validates the address locally before spending a provider request', async () => {
    const { state } = await run(actions.forgotPasswordAction, form({ email: 'nonsense' }));
    expect(state?.fieldErrors?.email).toBeTruthy();
    expect(client!.countOf('resetPasswordForEmail')).toBe(0);
  });
});

describe('resetPasswordAction', () => {
  it('sets the password for a real recovery session on a password account', async () => {
    client!.answers.getUser = { data: { user: PASSWORD_USER } };
    client!.answers.getClaims = RECOVERY_CLAIMS;
    const { redirectedTo } = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#1',
    }));
    expect(client!.countOf('updateUser')).toBe(1);
    // The recovery session is ended, so the new password has to be used once.
    expect(client!.countOf('signOut')).toBe(1);
    expect(redirectedTo?.startsWith('/auth/sign-in?message=')).toBe(true);
  });

  it('refuses to give a Google-only account a password, even with a valid recovery link', async () => {
    client!.answers.getUser = { data: { user: GOOGLE_ONLY_USER } };
    client!.answers.getClaims = RECOVERY_CLAIMS;
    const { state } = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#1',
    }));
    expect(state?.status).toBe('error');
    expect(state?.message).toContain('ผู้ให้บริการภายนอก');
    expect(client!.countOf('updateUser')).toBe(0);
  });

  it('refuses an ordinary signed-in session that never followed a recovery link', async () => {
    client!.answers.getUser = { data: { user: PASSWORD_USER } };
    client!.answers.getClaims = PASSWORD_CLAIMS;
    const { state } = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#1',
    }));
    expect(state?.status).toBe('error');
    expect(client!.countOf('updateUser')).toBe(0);
  });

  it('refuses when there is no session at all', async () => {
    client!.answers.getUser = { data: { user: null } };
    client!.answers.getClaims = { data: null };
    const { state } = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#1',
    }));
    expect(state?.status).toBe('error');
    expect(client!.countOf('updateUser')).toBe(0);
  });

  it('cannot be talked into a different verdict by form fields claiming an account type', async () => {
    client!.answers.getUser = { data: { user: GOOGLE_ONLY_USER } };
    client!.answers.getClaims = RECOVERY_CLAIMS;
    const { state } = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#1',
      // Every one of these is attacker-controlled input and must change nothing.
      provider: 'email',
      accountType: 'password',
      hasPasswordIdentity: 'true',
      amr: 'recovery',
      type: 'recovery',
    }));
    expect(state?.message).toContain('ผู้ให้บริการภายนอก');
    expect(client!.countOf('updateUser')).toBe(0);
  });

  it('checks the password policy and the confirmation before touching the session', async () => {
    const weak = await run(actions.resetPasswordAction, form({ password: 'weak', confirmPassword: 'weak' }));
    expect(weak.state?.fieldErrors?.password).toBeTruthy();
    expect(client!.countOf('getUser')).toBe(0);

    client = new FakeClient();
    const mismatch = await run(actions.resetPasswordAction, form({
      password: 'NewPortKheaw#1',
      confirmPassword: 'NewPortKheaw#2',
    }));
    expect(mismatch.state?.fieldErrors?.confirmPassword).toBeTruthy();
    expect(client.countOf('updateUser')).toBe(0);
  });
});
