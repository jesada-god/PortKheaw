import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/src/config/env/server';
import { canonicalizeEmail } from './canonical-email';
import {
  LEGACY_TRIAL_IDENTITY_SECRET_VAR,
  resolveTrialIdentityKeyring,
  TRIAL_IDENTITY_ACTIVE_VERSION_VAR,
  trialIdentitySecretVar,
  type TrialIdentityKeyring,
} from './keyring';

/**
 * The pseudonymous key a spent trial is remembered by.
 *
 * The ledger has to outlive the account, which means it has to hold *something*
 * after every other trace of the person is gone. That something is a keyed hash
 * and never the address itself:
 *
 *   * **keyed**, not plain SHA-256, because the space of email addresses is
 *     small enough to enumerate. An unkeyed digest of an address is the address.
 *     Without a key nobody holding a copy of the table can turn a row back into
 *     a mailbox.
 *   * **versioned**, because the day the key is rotated or the canonical rules
 *     change, old rows must stay readable as what they were rather than silently
 *     stop matching. The version is stored beside the digest and is part of the
 *     uniqueness constraint, so two versions of one identity are two rows and
 *     either of them blocks a second trial.
 *
 * Which is why there are two ways to derive an identity here, and the difference
 * between them is the whole rotation story:
 *
 *   * `…TrialIdentity(…)` derives under the **active** version. It is what a new
 *     claim is written with, so the table never accumulates one identity under
 *     every key we have ever held.
 *   * `…TrialIdentities(…)` derives under **every configured** version. It is
 *     what a lookup asks about, so a claim written under V1 still refuses a trial
 *     after the active version has moved to V2.
 *
 * The keys are read from the server environment and this module is
 * `server-only`, so a build that imported it from the browser fails rather than
 * shipping them. The canonical value is never returned, never logged and never
 * stored — it exists for the length of one `createHmac` call, and neither is a
 * digest ever paired with the value it came from anywhere but in memory.
 */

/** The identities a spent trial can be remembered by, strongest evidence first. */
export const trialIdentityTypes = ['email', 'oauth', 'payment'] as const;
export type TrialIdentityType = typeof trialIdentityTypes[number];

export interface TrialIdentity {
  type: TrialIdentityType;
  hash: string;
  version: number;
}

/**
 * Resolved once, at import, from the parsed server environment.
 *
 * Deliberately not memoized per call: the environment does not change inside a
 * running process, and a keyring that were re-read could differ between two
 * halves of one request — deriving a claim under one active version and writing
 * it under another.
 */
const keyring: TrialIdentityKeyring = resolveTrialIdentityKeyring({
  [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: serverEnv.TRIAL_IDENTITY_HMAC_SECRET,
  [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: serverEnv.TRIAL_IDENTITY_HMAC_ACTIVE_VERSION,
  [trialIdentitySecretVar(1)]: serverEnv.TRIAL_IDENTITY_HMAC_SECRET_V1,
  [trialIdentitySecretVar(2)]: serverEnv.TRIAL_IDENTITY_HMAC_SECRET_V2,
  [trialIdentitySecretVar(3)]: serverEnv.TRIAL_IDENTITY_HMAC_SECRET_V3,
  [trialIdentitySecretVar(4)]: serverEnv.TRIAL_IDENTITY_HMAC_SECRET_V4,
});

/**
 * Why the keyring could not be used, for an operator.
 *
 * Carries a reason code and a sentence naming variables — never a key, never a
 * length that could narrow one down beyond the published minimum.
 */
export class TrialIdentitySecretMissingError extends Error {
  readonly reason: string;

  constructor(keyringFailure?: { reason: string; message: string }) {
    super(keyringFailure?.message ?? 'TRIAL_IDENTITY_SECRET_MISSING');
    this.name = 'TrialIdentitySecretMissingError';
    this.reason = keyringFailure?.reason ?? 'no-keys';
  }
}

/** True when this deployment can derive identities at all. */
export function isTrialIdentityConfigured(): boolean {
  return keyring.ok;
}

/** The version new claims are written under. Throws when nothing is configured. */
export function activeTrialIdentityVersion(): number {
  if (!keyring.ok) throw new TrialIdentitySecretMissingError(keyring);
  return keyring.activeVersion;
}

/**
 * Every version a lookup can compute, ascending.
 *
 * The store sends this list to the database alongside the digests, so a claim
 * stamped with a version that is *not* in it can be detected and refused rather
 * than quietly missed.
 */
export function supportedTrialIdentityVersions(): number[] {
  return keyring.ok ? [...keyring.supportedVersions] : [];
}

/** Configuration health, for the operator's probe. Never a key or its length. */
export function trialIdentityKeyringStatus(): {
  ok: boolean;
  reason?: string;
  message?: string;
  activeVersion?: number;
  supportedVersions: number[];
  weakVersions: number[];
} {
  if (!keyring.ok) {
    return {
      ok: false,
      reason: keyring.reason,
      message: keyring.message,
      supportedVersions: [],
      weakVersions: [],
    };
  }
  return {
    ok: true,
    activeVersion: keyring.activeVersion,
    supportedVersions: [...keyring.supportedVersions],
    weakVersions: [...keyring.weakVersions],
  };
}

/**
 * The message the key is applied to.
 *
 * The type and the version are inside it, not merely stored alongside, so one
 * canonical value cannot produce the same digest under two meanings — an address
 * used as an `email` identity and the same address arriving as an `oauth`
 * identity are deliberately the same person and therefore the same digest only
 * because they share a type when we mean them to.
 *
 * The version is inside it too, which is what makes a rotation a genuinely new
 * derivation rather than the same digest wearing a different label.
 */
function digest(type: TrialIdentityType, canonicalValue: string, secret: string, version: number): string {
  return createHmac('sha256', secret)
    .update(`portkheaw:trial-identity:v${version}:${type}:${canonicalValue}`)
    .digest('hex');
}

function requireSecret(version: number): string {
  if (!keyring.ok) throw new TrialIdentitySecretMissingError(keyring);
  const secret = keyring.secretFor(version);
  if (secret === undefined) {
    throw new TrialIdentitySecretMissingError({
      reason: 'active-key-missing',
      message: `${trialIdentitySecretVar(version)} is not configured.`,
    });
  }
  return secret;
}

/** The identity under the active version, for writing. */
function active(type: TrialIdentityType, canonicalValue: string): TrialIdentity {
  const version = activeTrialIdentityVersion();
  return { type, hash: digest(type, canonicalValue, requireSecret(version), version), version };
}

/** The identity under every configured version, for reading. */
function everyVersion(type: TrialIdentityType, canonicalValue: string): TrialIdentity[] {
  if (!keyring.ok) throw new TrialIdentitySecretMissingError(keyring);
  return keyring.supportedVersions.map((version) => ({
    type,
    hash: digest(type, canonicalValue, requireSecret(version), version),
    version,
  }));
}

/**
 * The canonical value each identity type is derived from, or nothing when the
 * input cannot produce one. Shared by the single- and every-version derivations
 * so the two can never disagree about what one mailbox means.
 */
function emailValue(email: string | null | undefined): string | null {
  return canonicalizeEmail(email);
}

function oauthValue(provider: string | null | undefined, subject: string | null | undefined): string | null {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const normalizedSubject = typeof subject === 'string' ? subject.trim() : '';
  if (!normalizedProvider || !normalizedSubject) return null;
  return `${normalizedProvider}:${normalizedSubject}`;
}

function paymentValue(fingerprint: string | null | undefined): string | null {
  const normalized = typeof fingerprint === 'string' ? fingerprint.trim() : '';
  return normalized ? normalized : null;
}

/**
 * The email identity, from any spelling of the address.
 *
 * Google sign-in and email/password sign-up on one address both resolve here, on
 * purpose: they are one mailbox and therefore one trial. That is what makes
 * "delete, then sign in with Google instead" a dead end.
 */
export function emailTrialIdentity(email: string | null | undefined): TrialIdentity | null {
  const canonical = emailValue(email);
  return canonical === null ? null : active('email', canonical);
}

/** The same mailbox under every key this deployment holds. */
export function emailTrialIdentities(email: string | null | undefined): TrialIdentity[] {
  const canonical = emailValue(email);
  return canonical === null ? [] : everyVersion('email', canonical);
}

/**
 * The provider-subject identity, when the provider actually gave us one.
 *
 * Stronger than the address — a Google subject survives an address change — but
 * only available for accounts that signed in with Google, so it supplements the
 * email identity rather than replacing it.
 */
export function oauthTrialIdentity(
  provider: string | null | undefined,
  subject: string | null | undefined,
): TrialIdentity | null {
  const canonical = oauthValue(provider, subject);
  return canonical === null ? null : active('oauth', canonical);
}

export function oauthTrialIdentities(
  provider: string | null | undefined,
  subject: string | null | undefined,
): TrialIdentity[] {
  const canonical = oauthValue(provider, subject);
  return canonical === null ? [] : everyVersion('oauth', canonical);
}

/**
 * The payment-instrument identity.
 *
 * Recorded as a *signal* and never as a block. A card is shared between family
 * members, reissued to a stranger, and used by one person to pay for another's
 * account — so refusing a trial because a card was seen before would refuse
 * people who have never had one. It is derived and stored so that abuse is
 * visible; the eligibility rule below never reads it.
 */
export function paymentTrialIdentity(fingerprint: string | null | undefined): TrialIdentity | null {
  const canonical = paymentValue(fingerprint);
  return canonical === null ? null : active('payment', canonical);
}

/** Constant-time comparison, for tests and for any future re-derivation check. */
export function trialIdentityHashEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
