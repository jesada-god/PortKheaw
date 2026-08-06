import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/src/config/env/server';
import { canonicalizeEmail } from './canonical-email';

/**
 * The pseudonymous key a spent trial is remembered by.
 *
 * The ledger has to outlive the account, which means it has to hold *something*
 * after every other trace of the person is gone. That something is a keyed hash
 * and never the address itself:
 *
 *   * **keyed**, not plain SHA-256, because the space of email addresses is
 *     small enough to enumerate. An unkeyed digest of an address is the address.
 *     Without `TRIAL_IDENTITY_HMAC_SECRET` nobody holding a copy of the table can
 *     turn a row back into a mailbox.
 *   * **versioned**, because the day the key is rotated or the canonical rules
 *     change, old rows must stay readable as what they were rather than silently
 *     stop matching. The version is stored beside the digest and is part of the
 *     uniqueness constraint, so two versions of one identity are two rows and
 *     either of them blocks a second trial.
 *
 * The secret is read from the server environment and this module is
 * `server-only`, so a build that imported it from the browser fails rather than
 * shipping the key. The canonical value is never returned, never logged and
 * never stored — it exists for the length of one `createHmac` call.
 */

/** The identities a spent trial can be remembered by, strongest evidence first. */
export const trialIdentityTypes = ['email', 'oauth', 'payment'] as const;
export type TrialIdentityType = typeof trialIdentityTypes[number];

/**
 * The current derivation. Bump when the key rotates or the canonical rules
 * change; never reuse a number, and never rewrite rows carrying an older one.
 */
export const TRIAL_IDENTITY_HASH_VERSION = 1;

export interface TrialIdentity {
  type: TrialIdentityType;
  hash: string;
  version: number;
}

export class TrialIdentitySecretMissingError extends Error {
  constructor() {
    super('TRIAL_IDENTITY_SECRET_MISSING');
    this.name = 'TrialIdentitySecretMissingError';
  }
}

/** True when this deployment can derive identities at all. */
export function isTrialIdentityConfigured(): boolean {
  return typeof serverEnv.TRIAL_IDENTITY_HMAC_SECRET === 'string'
    && serverEnv.TRIAL_IDENTITY_HMAC_SECRET.length > 0;
}

/**
 * The message the key is applied to.
 *
 * The type and the version are inside it, not merely stored alongside, so one
 * canonical value cannot produce the same digest under two meanings — an address
 * used as an `email` identity and the same address arriving as an `oauth`
 * identity are deliberately the same person and therefore the same digest only
 * because they share a type when we mean them to.
 */
function digest(type: TrialIdentityType, canonicalValue: string, secret: string, version: number): string {
  return createHmac('sha256', secret)
    .update(`portkheaw:trial-identity:v${version}:${type}:${canonicalValue}`)
    .digest('hex');
}

function requireSecret(): string {
  const secret = serverEnv.TRIAL_IDENTITY_HMAC_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) throw new TrialIdentitySecretMissingError();
  return secret;
}

/**
 * The email identity, from any spelling of the address.
 *
 * Google sign-in and email/password sign-up on one address both resolve here, on
 * purpose: they are one mailbox and therefore one trial. That is what makes
 * "delete, then sign in with Google instead" a dead end.
 */
export function emailTrialIdentity(email: string | null | undefined): TrialIdentity | null {
  const canonical = canonicalizeEmail(email);
  if (!canonical) return null;
  return {
    type: 'email',
    hash: digest('email', canonical, requireSecret(), TRIAL_IDENTITY_HASH_VERSION),
    version: TRIAL_IDENTITY_HASH_VERSION,
  };
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
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const normalizedSubject = typeof subject === 'string' ? subject.trim() : '';
  if (!normalizedProvider || !normalizedSubject) return null;
  return {
    type: 'oauth',
    hash: digest('oauth', `${normalizedProvider}:${normalizedSubject}`, requireSecret(), TRIAL_IDENTITY_HASH_VERSION),
    version: TRIAL_IDENTITY_HASH_VERSION,
  };
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
  const normalized = typeof fingerprint === 'string' ? fingerprint.trim() : '';
  if (!normalized) return null;
  return {
    type: 'payment',
    hash: digest('payment', normalized, requireSecret(), TRIAL_IDENTITY_HASH_VERSION),
    version: TRIAL_IDENTITY_HASH_VERSION,
  };
}

/** Constant-time comparison, for tests and for any future re-derivation check. */
export function trialIdentityHashEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
