import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The derivation, exercised the only way it can be: through a fresh module
 * graph, because the secret is read from the parsed server environment at import
 * time and a test that stubbed it afterwards would be testing nothing.
 */
type IdentityModule = typeof import('./identity-hash');

async function load(secret: string | undefined): Promise<IdentityModule> {
  vi.resetModules();
  if (secret === undefined) vi.stubEnv('TRIAL_IDENTITY_HMAC_SECRET', '');
  else vi.stubEnv('TRIAL_IDENTITY_HMAC_SECRET', secret);
  return import('./identity-hash');
}

const SECRET = 'a-test-key-that-is-not-the-production-one';

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
    const { emailTrialIdentity } = await load(SECRET);
    for (const input of ['', 'reader', null, undefined]) expect(emailTrialIdentity(input)).toBeNull();
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

  it('stamps the version it was derived under, so a rotation does not silently stop matching', async () => {
    const { emailTrialIdentity, TRIAL_IDENTITY_HASH_VERSION } = await load(SECRET);
    expect(emailTrialIdentity('reader@example.com')!.version).toBe(TRIAL_IDENTITY_HASH_VERSION);
    expect(TRIAL_IDENTITY_HASH_VERSION).toBeGreaterThanOrEqual(1);
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
    const { oauthTrialIdentity, paymentTrialIdentity } = await load(SECRET);
    expect(oauthTrialIdentity('google', null)).toBeNull();
    expect(oauthTrialIdentity(null, 'subject')).toBeNull();
    expect(oauthTrialIdentity('google', '   ')).toBeNull();
    expect(paymentTrialIdentity('  ')).toBeNull();
    expect(paymentTrialIdentity(null)).toBeNull();
  });
});
