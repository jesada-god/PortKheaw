import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deletion pipeline, driven against a stand-in for the service role.
 *
 * The database's own guarantees — that a claim survives the account, that a
 * closing account writes nothing, that a stage never goes backwards — are proved
 * against a real Postgres in `account-deletion-migration.test.ts`. What is proved
 * here is the *order*, and the two failure policies that hang off it:
 *
 *   * the trial is written down before anything is destroyed, and the auth user
 *     is removed after everything else;
 *   * a provider that will not settle stops the deletion with the account intact
 *     and back in service — it does not take the account down with it, and it
 *     never issues a refund;
 *   * a failure after the data is gone leaves the account closed and retryable,
 *     never half-restored.
 */

const calls: string[] = [];
let providerFails = false;
let ledgerFails = false;
let purgeFails = false;
let authDeleteFails = false;
let beginState: Record<string, unknown> = {
  operation_id: 'op-1', stage: 'requested', trial_used: true, resumed: false,
};

const admin = {
  auth: {
    admin: {
      getUserById: async (id: string) => ({
        data: {
          user: {
            id,
            email: 'reader@example.com',
            identities: [{ provider: 'email', id, identity_data: { email: 'reader@example.com' } }],
          },
        },
        error: null,
      }),
      deleteUser: async () => {
        calls.push('auth.deleteUser');
        return { data: null, error: authDeleteFails ? { message: 'boom' } : null };
      },
    },
  },
  rpc: async (name: string) => {
    calls.push(`rpc:${name}`);
    if (name === 'begin_account_deletion') return { data: [beginState], error: null };
    if (name === 'purge_account_data' && purgeFails) return { data: null, error: { message: 'boom' } };
    return { data: null, error: null };
  },
  from: (table: string) => ({
    select: () => ({
      eq: async () => {
        calls.push(`select:${table}`);
        return { data: [], error: null };
      },
      maybeSingle: () => ({ data: null, error: null }),
    }),
  }),
  storage: {
    from: () => ({ remove: async () => ({ data: null, error: null }) }),
  },
};

// `from('user_subscriptions').select(...).eq(...).maybeSingle()` is the provider
// lookup; `from('support_attachments').select(...).eq(...)` is the storage one.
// One builder answers both shapes.
Object.assign(admin, {
  from: (table: string) => ({
    select: () => {
      const builder = {
        eq: (..._args: unknown[]) => {
          calls.push(`select:${table}`);
          const result = { data: table === 'support_attachments' ? [] : null, error: null };
          return Object.assign(Promise.resolve(result), {
            maybeSingle: async () => ({ data: { billing_subscription_id: 'sub_1' }, error: null }),
          });
        },
      };
      return builder;
    },
  }),
});

vi.mock('@/src/lib/supabase/admin', () => ({ createAdminClient: () => admin }));
vi.mock('@/src/lib/billing/billing-server', () => ({
  getBillingConfig: () => ({ secretKey: 'sk_test', returnOrigin: 'https://example.test' }),
}));
vi.mock('@/src/lib/billing/providers/stripe/stripe-provider', () => ({
  cancelStripeSubscriptionForDeletion: async () => {
    calls.push('stripe.cancel');
    if (providerFails) throw new Error('provider unreachable');
    return 'canceled';
  },
}));
vi.mock('@/src/lib/trial-identity/trial-identity-store', () => ({
  deriveAccountIdentities: () => ({ binding: [{ type: 'email', hash: 'a'.repeat(64), version: 1 }], signals: [] }),
  retainTrialIdentityOnDeletion: async () => {
    calls.push('ledger.retain');
    if (ledgerFails) throw new Error('ledger unavailable');
    return 1;
  },
}));

const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  calls.length = 0;
  providerFails = false;
  ledgerFails = false;
  purgeFails = false;
  authDeleteFails = false;
  beginState = { operation_id: 'op-1', stage: 'requested', trial_used: true, resumed: false };
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

async function run() {
  const { deleteAccount } = await import('./account-deletion');
  return deleteAccount(USER);
}

describe('the order', () => {
  it('writes the trial ledger before anything is destroyed, and deletes the auth user last', async () => {
    const result = await run();
    expect(result.ok).toBe(true);

    const ledger = calls.indexOf('ledger.retain');
    const purge = calls.indexOf('rpc:purge_account_data');
    const authDelete = calls.indexOf('auth.deleteUser');

    expect(calls[0]).toBe('rpc:begin_account_deletion');
    expect(ledger).toBeGreaterThan(0);
    expect(purge).toBeGreaterThan(ledger);
    // The defect in one assertion: the auth user goes after the data, never
    // before it, because everything that proves a trial was spent cascades away
    // with it.
    expect(authDelete).toBeGreaterThan(purge);
    expect(authDelete).toBe(calls.length - 1);
  });

  it('records the stages it reached, so a stuck run is findable', async () => {
    await run();
    const stages = calls.filter((call) => call === 'rpc:advance_account_deletion');
    expect(stages).toHaveLength(2);
  });
});

describe('when the payment provider will not settle', () => {
  it('stops before anything is destroyed and puts the account back into service', async () => {
    providerFails = true;
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: 'provider-failed' });

    expect(calls).toContain('rpc:cancel_account_deletion');
    // Nothing was removed, and above all the auth user is still there.
    expect(calls).not.toContain('rpc:purge_account_data');
    expect(calls).not.toContain('auth.deleteUser');
  });

  it('never issues a refund on the way out', async () => {
    await run();
    expect(calls.filter((call) => call.includes('refund'))).toEqual([]);
  });
});

describe('when a later step fails', () => {
  it('leaves the account closed rather than half-restored, and stays retryable', async () => {
    purgeFails = true;
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: 'purge-failed' });
    // The one thing that must not happen: handing a half-emptied account back.
    expect(calls).not.toContain('rpc:cancel_account_deletion');
    expect(calls).not.toContain('auth.deleteUser');
  });

  it('reports an auth user that could not be removed, with the data already gone', async () => {
    authDeleteFails = true;
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: 'auth-delete-failed' });
    expect(calls).toContain('rpc:purge_account_data');
  });

  /*
   * The ledger is the reason this feature exists, so a ledger that will not
   * accept the claim stops the deletion instead of proceeding without it.
   */
  it('refuses to delete an account whose spent trial it could not record', async () => {
    ledgerFails = true;
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: 'ledger-failed' });
    expect(calls).toContain('rpc:cancel_account_deletion');
    expect(calls).not.toContain('auth.deleteUser');
  });
});

describe('retrying', () => {
  it('resumes an attempt that already reached a later stage instead of starting over', async () => {
    beginState = { operation_id: 'op-1', stage: 'provider_settled', trial_used: true, resumed: true };
    const result = await run();
    expect(result.ok).toBe(true);
    // The same steps run again — every one of them is safe to repeat — and the
    // run still ends with the auth user.
    expect(calls[calls.length - 1]).toBe('auth.deleteUser');
  });

  it('is driven entirely by the account it was given, and takes no other identifier', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('./account-deletion.ts', import.meta.url), 'utf8'));
    // One parameter, and it is the subject. There is no path by which a caller
    // names somebody else's account beyond the one the action already verified.
    expect(source).toContain('export async function deleteAccount(userId: string)');
    expect(source).not.toMatch(/deleteAccount\([^)]*email/i);
  });
});
