import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store, across a key rotation.
 *
 * One property matters more than everything else here: **what is written and what
 * is read are deliberately different sets.** A claim is written under the active
 * version alone, and a lookup asks about every version a key exists for. Get that
 * backwards and rotating the secret hands a second free week to every person who
 * has already had one — with no error, in no log, until somebody notices the
 * revenue.
 *
 * The Supabase admin client is a stub, so these assert the arguments the store
 * sends and the decisions it makes from what comes back. The database side of the
 * same contract is proved against a real Postgres in
 * `retention-migration.test.ts`.
 */

type StoreModule = typeof import('./trial-identity-store');

const V1 = 'the-first-key-long-enough-to-pass';
const V2 = 'the-second-key-long-enough-to-pass';

interface RpcCall { name: string; args: Record<string, unknown> }

let calls: RpcCall[];
let rpcResult: { data: unknown; error: unknown };

vi.mock('@/src/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  }),
}));

const KEY_VARS = [
  'TRIAL_IDENTITY_HMAC_SECRET',
  'TRIAL_IDENTITY_HMAC_ACTIVE_VERSION',
  'TRIAL_IDENTITY_HMAC_SECRET_V1',
  'TRIAL_IDENTITY_HMAC_SECRET_V2',
  'TRIAL_IDENTITY_HMAC_SECRET_V3',
  'TRIAL_IDENTITY_HMAC_SECRET_V4',
] as const;

async function load(env: Partial<Record<typeof KEY_VARS[number], string>>): Promise<StoreModule> {
  vi.resetModules();
  for (const name of KEY_VARS) vi.stubEnv(name, env[name] ?? '');
  return import('./trial-identity-store');
}

/** Version 1 only: the deployment as production runs it today. */
const singleKey = { TRIAL_IDENTITY_HMAC_SECRET_V1: V1 };
/** Rotated: V2 writes, V1 still reads. */
const rotated = {
  TRIAL_IDENTITY_HMAC_SECRET_V1: V1,
  TRIAL_IDENTITY_HMAC_SECRET_V2: V2,
  TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
};

const READER = { email: 'reader@example.com' };

beforeEach(() => {
  calls = [];
  rpcResult = { data: [{ claimed: false, unsupported_versions: [] }], error: null };
});
afterEach(() => vi.unstubAllEnvs());

describe('what gets derived', () => {
  it('writes one version and reads one version before any rotation', async () => {
    const { deriveAccountIdentities } = await load(singleKey);
    const { binding, lookup } = deriveAccountIdentities(READER);
    expect(binding.map((identity) => identity.version)).toEqual([1]);
    expect(lookup.map((identity) => identity.version)).toEqual([1]);
    expect(lookup[0].hash).toBe(binding[0].hash);
  });

  /*
   * The rotation invariant. `binding` is what a claim and a deletion write, so it
   * must not grow; `lookup` is what a refusal is decided from, so it must.
   */
  it('writes only the active version but reads both after a rotation', async () => {
    const { deriveAccountIdentities } = await load(rotated);
    const { binding, lookup } = deriveAccountIdentities(READER);
    expect(binding.map((identity) => identity.version)).toEqual([2]);
    expect(lookup.map((identity) => identity.version).sort()).toEqual([1, 2]);
    // The V1 digest in `lookup` is the one already sitting in the ledger.
    const { lookup: before } = (await load(singleKey)).deriveAccountIdentities(READER);
    const rotatedAgain = (await load(rotated)).deriveAccountIdentities(READER);
    expect(rotatedAgain.lookup.find((identity) => identity.version === 1)!.hash)
      .toBe(before[0].hash);
  });

  it('covers a provider identity and every address on the account', async () => {
    const { deriveAccountIdentities } = await load(rotated);
    const { binding, lookup } = deriveAccountIdentities({
      email: 'reader@example.com',
      identities: [
        { provider: 'google', id: '10769150350006150715', identity_data: { email: 'other@example.com' } },
      ],
    });
    // Two addresses and one subject, under one version for writing …
    expect(binding).toHaveLength(3);
    expect(new Set(binding.map((identity) => identity.version))).toEqual(new Set([2]));
    // … and under both for reading.
    expect(lookup).toHaveLength(6);
  });

  it('keeps a payment fingerprint out of both, as a signal only', async () => {
    const { deriveAccountIdentities } = await load(rotated);
    const { binding, lookup, signals } = deriveAccountIdentities(READER, ['fingerprint-abc']);
    expect(signals.map((identity) => identity.type)).toEqual(['payment']);
    expect(binding.some((identity) => identity.type === 'payment')).toBe(false);
    expect(lookup.some((identity) => identity.type === 'payment')).toBe(false);
  });

  it('derives nothing at all with no key configured', async () => {
    const { deriveAccountIdentities, trialIdentityAvailable } = await load({});
    expect(trialIdentityAvailable()).toBe(false);
    expect(() => deriveAccountIdentities(READER)).toThrow();
  });
});

describe('asking the ledger', () => {
  it('sends every supported version alongside the digests, in one call', async () => {
    const { deriveAccountIdentities, lookupTrialIdentityClaim } = await load(rotated);
    const { lookup } = deriveAccountIdentities(READER);
    await lookupTrialIdentityClaim(lookup);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('trial_identity_claim_status');
    expect(calls[0].args.input_versions).toEqual([1, 2]);
    // Digests only: no address, no canonical value, nothing but type/hash/version.
    for (const identity of calls[0].args.input_identities as Array<Record<string, unknown>>) {
      expect(Object.keys(identity).sort()).toEqual(['hash', 'type', 'version']);
    }
    expect(JSON.stringify(calls[0].args)).not.toContain('reader@example.com');
  });

  /*
   * The regression this release exists to prevent, at the store's own level: the
   * ledger answers about a V1 row, the deployment has moved to V2, and the answer
   * must still be "claimed".
   */
  it('refuses a reader whose only claim is under the retired version', async () => {
    rpcResult = { data: [{ claimed: true, unsupported_versions: [] }], error: null };
    const { deriveAccountIdentities, lookupTrialIdentityClaim } = await load(rotated);
    const { lookup } = deriveAccountIdentities(READER);
    expect(await lookupTrialIdentityClaim(lookup)).toBe('claimed');
  });

  it('admits a reader with no claim under any version', async () => {
    const { deriveAccountIdentities, lookupTrialIdentityClaim } = await load(rotated);
    const { lookup } = deriveAccountIdentities(READER);
    expect(await lookupTrialIdentityClaim(lookup)).toBe('unclaimed');
  });

  /*
   * The bypass that rotation could otherwise open. A stored version we hold no key
   * for cannot be derived, so "no match" proves nothing — and the safe reading of
   * "I cannot tell" is a refusal, never a free week.
   */
  it('fails closed when the ledger holds a version it cannot compute', async () => {
    rpcResult = { data: [{ claimed: false, unsupported_versions: [3] }], error: null };
    const { deriveAccountIdentities, lookupTrialIdentityClaim } = await load(rotated);
    const { lookup } = deriveAccountIdentities(READER);
    expect(await lookupTrialIdentityClaim(lookup)).toBe('unsupported-version');
  });

  it('fails closed on an error, an unreadable answer, or nothing to ask about', async () => {
    const { deriveAccountIdentities, lookupTrialIdentityClaim } = await load(rotated);
    const { lookup } = deriveAccountIdentities(READER);

    rpcResult = { data: null, error: { message: 'boom' } };
    expect(await lookupTrialIdentityClaim(lookup)).toBe('unavailable');

    rpcResult = { data: [{ claimed: 'yes' }], error: null };
    expect(await lookupTrialIdentityClaim(lookup)).toBe('unavailable');

    rpcResult = { data: [], error: null };
    expect(await lookupTrialIdentityClaim(lookup)).toBe('unavailable');

    rpcResult = { data: [{ claimed: false, unsupported_versions: [] }], error: null };
    expect(await lookupTrialIdentityClaim([])).toBe('unavailable');
  });

  it('never asks at all when no key is configured', async () => {
    const { lookupTrialIdentityClaim } = await load({});
    expect(await lookupTrialIdentityClaim([
      { type: 'email', hash: 'a'.repeat(64), version: 1 },
    ])).toBe('unavailable');
    expect(calls).toEqual([]);
  });
});

describe('writing the ledger', () => {
  it('claims and grants under the active version alone', async () => {
    rpcResult = {
      data: [{ trial_ends_at: 't', trial_used_at: null, database_now: 'n' }],
      error: null,
    };
    const { deriveAccountIdentities, claimAndStartEliteTrial } = await load(rotated);
    const { binding } = deriveAccountIdentities(READER);
    await claimAndStartEliteTrial('user-1', binding);

    expect(calls[0].name).toBe('start_elite_trial_with_identity');
    const sent = calls[0].args.input_identities as Array<{ version: number }>;
    expect(new Set(sent.map((identity) => identity.version))).toEqual(new Set([2]));
  });

  /*
   * A deletion writes the active version too. The row the account already holds
   * under V1 is not rewritten — the database releases it and keeps it, so both
   * versions go on refusing.
   */
  it('retains the active version on deletion and nothing older', async () => {
    rpcResult = { data: 1, error: null };
    const { deriveAccountIdentities, retainTrialIdentityOnDeletion } = await load(rotated);
    const { binding } = deriveAccountIdentities(READER);
    await retainTrialIdentityOnDeletion({ userId: 'user-1', identities: binding, trialUsed: true });

    expect(calls[0].name).toBe('retain_trial_identity_on_deletion');
    const sent = calls[0].args.input_identities as Array<{ version: number }>;
    expect(new Set(sent.map((identity) => identity.version))).toEqual(new Set([2]));
    expect(calls[0].args.input_trial_used).toBe(true);
  });
});
