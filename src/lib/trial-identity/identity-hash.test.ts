import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The derivation, exercised the only way it can be: through a fresh module
 * graph, because the keyring is resolved from the parsed server environment at
 * import time and a test that stubbed it afterwards would be testing nothing.
 */
type IdentityModule = typeof import('./identity-hash');

const SECRET = 'a-test-key-that-is-not-the-production-one';
const SECOND_KEY = 'the-second-key-a-rotation-introduces';

/** Every variable the keyring reads, so a case cannot inherit another's. */
const KEY_VARS = [
  'TRIAL_IDENTITY_HMAC_SECRET',
  'TRIAL_IDENTITY_HMAC_ACTIVE_VERSION',
  'TRIAL_IDENTITY_HMAC_SECRET_V1',
  'TRIAL_IDENTITY_HMAC_SECRET_V2',
  'TRIAL_IDENTITY_HMAC_SECRET_V3',
  'TRIAL_IDENTITY_HMAC_SECRET_V4',
] as const;

async function loadWith(env: Partial<Record<typeof KEY_VARS[number], string>>): Promise<IdentityModule> {
  vi.resetModules();
  for (const name of KEY_VARS) vi.stubEnv(name, env[name] ?? '');
  return import('./identity-hash');
}

/** The single-secret deployment, which is what production is today. */
async function load(secret: string | undefined): Promise<IdentityModule> {
  return loadWith(secret === undefined ? {} : { TRIAL_IDENTITY_HMAC_SECRET: secret });
}

beforeEach(() => vi.stubEnv('TRIAL_IDENTITY_HMAC_SECRET', SECRET));
afterEach(() => vi.unstubAllEnvs());

describe('the email identity', () => {
  it('is a lower-case hex SHA-256 digest and never the address', async () => {
    const { emailTrialIdentity } = await load(SECRET);
    const identity = emailTrialIdentity('reader@example.com');
    expect(identity).not.toBeNull();
    expect(identity!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity!.hash).not.toContain('reader');
    expect(identity!.type).toBe('email');
    expect(identity!.version).toBe(1);
  });

  /*
   * The rule the whole feature rests on: one mailbox is one claim, whichever
   * spelling it arrives in and whichever provider it signs in through.
   */
  it('gives every spelling of one Gmail mailbox the same digest', async () => {
    const { emailTrialIdentity } = await load(SECRET);
    const digests = [
      'jesada.twt@gmail.com',
      'JESADATWT@GMAIL.COM',
      'jesadatwt+trial@googlemail.com',
      ' Jesada.Twt+a.b@googlemail.com ',
    ].map((address) => emailTrialIdentity(address)!.hash);
    expect(new Set(digests).size).toBe(1);
  });

  it('gives two genuinely different mailboxes different digests', async () => {
    const { emailTrialIdentity } = await load(SECRET);
    expect(emailTrialIdentity('a.b@outlook.com')!.hash)
      .not.toBe(emailTrialIdentity('ab@outlook.com')!.hash);
  });

  it('yields nothing at all for an address it cannot canonicalize', async () => {
    const { emailTrialIdentity, emailTrialIdentities } = await load(SECRET);
    for (const input of ['', 'reader', null, undefined]) {
      expect(emailTrialIdentity(input)).toBeNull();
      expect(emailTrialIdentities(input)).toEqual([]);
    }
  });
});

describe('keying and versioning', () => {
  /*
   * The reason it is an HMAC and not a plain digest: the space of addresses is
   * small enough to enumerate, so an unkeyed hash of an address *is* the
   * address. A different key must therefore produce a different value.
   */
  it('produces a different digest under a different secret', async () => {
    const one = await load(SECRET);
    const other = await load('a-completely-different-key');
    expect(one.emailTrialIdentity('reader@example.com')!.hash)
      .not.toBe(other.emailTrialIdentity('reader@example.com')!.hash);
  });

  it('separates the identity types, so one value cannot mean two things', async () => {
    const { emailTrialIdentity, oauthTrialIdentity, paymentTrialIdentity } = await load(SECRET);
    const digests = new Set([
      emailTrialIdentity('reader@example.com')!.hash,
      oauthTrialIdentity('google', 'reader@example.com')!.hash,
      paymentTrialIdentity('reader@example.com')!.hash,
    ]);
    expect(digests.size).toBe(3);
  });

  it('stamps the active version, so a rotation does not silently stop matching', async () => {
    const { emailTrialIdentity, activeTrialIdentityVersion } = await load(SECRET);
    expect(emailTrialIdentity('reader@example.com')!.version).toBe(activeTrialIdentityVersion());
    expect(activeTrialIdentityVersion()).toBeGreaterThanOrEqual(1);
  });

  /*
   * Not "fall back to an unkeyed hash", and not "grant the trial anyway". A
   * deployment that cannot derive an identity cannot record a trial, and the
   * eligibility service refuses on that basis rather than handing out a week it
   * will not be able to remember.
   */
  it('refuses to derive anything without a configured secret', async () => {
    const unconfigured = await load(undefined);
    expect(unconfigured.isTrialIdentityConfigured()).toBe(false);
    expect(() => unconfigured.emailTrialIdentity('reader@example.com'))
      .toThrow(unconfigured.TrialIdentitySecretMissingError);
    expect(unconfigured.supportedTrialIdentityVersions()).toEqual([]);
  });
});

/**
 * Rotation, which is the point of this release.
 *
 * The property under test is one sentence: after the active version moves, a
 * person whose claim was written under the old key must still be recognised. If
 * that fails, rotating the secret hands a second free week to everybody who ever
 * had one — silently, and with no error anywhere.
 */
describe('rotating the key', () => {
  const ADDRESS = 'returning.reader@example.com';

  it('keeps deriving the old version alongside the new one', async () => {
    const before = await loadWith({ TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET });
    const v1Digest = before.emailTrialIdentity(ADDRESS)!.hash;

    const after = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET,
      TRIAL_IDENTITY_HMAC_SECRET_V2: SECOND_KEY,
      TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
    });

    // New claims are written under V2 …
    const active = after.emailTrialIdentity(ADDRESS)!;
    expect(active.version).toBe(2);
    expect(active.hash).not.toBe(v1Digest);

    // … and a lookup still asks about V1, with the identical digest the ledger
    // already holds. This is the assertion that stops the second free week.
    const lookup = after.emailTrialIdentities(ADDRESS);
    expect(lookup.map((identity) => identity.version)).toEqual([1, 2]);
    expect(lookup.find((identity) => identity.version === 1)!.hash).toBe(v1Digest);
    expect(after.supportedTrialIdentityVersions()).toEqual([1, 2]);
  });

  it('derives every version for a provider identity too', async () => {
    const rotated = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET,
      TRIAL_IDENTITY_HMAC_SECRET_V2: SECOND_KEY,
      TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
    });
    const derived = rotated.oauthTrialIdentities('google', '10769150350006150715');
    expect(derived.map((identity) => identity.version)).toEqual([1, 2]);
    expect(new Set(derived.map((identity) => identity.hash)).size).toBe(2);
    expect(rotated.oauthTrialIdentity('google', '10769150350006150715')!.version).toBe(2);
  });

  /*
   * The version is inside the HMAC message, not merely stored beside the digest.
   * Without that, one key under two version labels would produce the same digest
   * twice and the version stamp would be decoration.
   */
  it('makes the version part of the derivation rather than a label on it', async () => {
    const asV1 = await loadWith({ TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET });
    const asV2 = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET_V2: SECRET,
      TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
    });
    expect(asV1.emailTrialIdentity(ADDRESS)!.hash)
      .not.toBe(asV2.emailTrialIdentity(ADDRESS)!.hash);
  });

  it('reports the keyring as unusable, with an actionable reason, when the active key is gone', async () => {
    const broken = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET,
      TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
    });
    expect(broken.isTrialIdentityConfigured()).toBe(false);

    const status = broken.trialIdentityKeyringStatus();
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('active-key-missing');
    expect(status.message).toContain('TRIAL_IDENTITY_HMAC_SECRET_V2');
    expect(status.message).not.toContain(SECRET);

    // And nothing derives, rather than deriving under some other version.
    expect(() => broken.emailTrialIdentity(ADDRESS)).toThrow(broken.TrialIdentitySecretMissingError);
    expect(() => broken.activeTrialIdentityVersion()).toThrow(/TRIAL_IDENTITY_HMAC_SECRET_V2/);
  });

  it('takes the whole feature down rather than half-honouring a conflicting V1', async () => {
    const conflicting = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET: SECRET,
      TRIAL_IDENTITY_HMAC_SECRET_V1: SECOND_KEY,
    });
    expect(conflicting.isTrialIdentityConfigured()).toBe(false);
    expect(conflicting.trialIdentityKeyringStatus().reason).toBe('legacy-conflict');
  });

  it('exposes health without exposing a key or its length', async () => {
    const rotated = await loadWith({
      TRIAL_IDENTITY_HMAC_SECRET_V1: SECRET,
      TRIAL_IDENTITY_HMAC_SECRET_V2: SECOND_KEY,
      TRIAL_IDENTITY_HMAC_ACTIVE_VERSION: '2',
    });
    const status = rotated.trialIdentityKeyringStatus();
    expect(status).toEqual({
      ok: true,
      activeVersion: 2,
      supportedVersions: [1, 2],
      weakVersions: [],
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain(SECOND_KEY);
  });
});

describe('the provider and payment identities', () => {
  it('normalizes the provider name and keeps the subject verbatim', async () => {
    const { oauthTrialIdentity } = await load(SECRET);
    expect(oauthTrialIdentity(' Google ', '10769150350006150715')!.hash)
      .toBe(oauthTrialIdentity('google', '10769150350006150715')!.hash);
    expect(oauthTrialIdentity('google', '10769150350006150715')!.hash)
      .not.toBe(oauthTrialIdentity('google', '10769150350006150716')!.hash);
  });

  it('yields nothing when the provider gave us no subject', async () => {
    const { oauthTrialIdentity, oauthTrialIdentities, paymentTrialIdentity } = await load(SECRET);
    expect(oauthTrialIdentity('google', null)).toBeNull();
    expect(oauthTrialIdentity(null, 'subject')).toBeNull();
    expect(oauthTrialIdentity('google', '   ')).toBeNull();
    expect(oauthTrialIdentities('google', null)).toEqual([]);
    expect(paymentTrialIdentity('  ')).toBeNull();
    expect(paymentTrialIdentity(null)).toBeNull();
  });
});
