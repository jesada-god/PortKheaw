import { describe, expect, it } from 'vitest';
import {
  LEGACY_TRIAL_IDENTITY_SECRET_VAR,
  resolveTrialIdentityKeyring,
  TRIAL_IDENTITY_ACTIVE_VERSION_VAR,
  TRIAL_IDENTITY_MAX_KEY_VERSION,
  trialIdentitySecretVar,
} from './keyring';

/**
 * The keyring, exercised as the state machine a rotation actually walks through.
 *
 * Every case here is a real configuration somebody can be in halfway through the
 * runbook, and the interesting ones are the failures: a rotation that half
 * happened must take the feature *down* rather than quietly stop recognising the
 * claims already in the table, because the second one hands out free weeks.
 */

const V1 = 'v1-key-that-is-long-enough-to-pass';
const V2 = 'v2-key-that-is-long-enough-to-pass';
const V3 = 'v3-key-that-is-long-enough-to-pass';

function keyring(env: Record<string, unknown>) {
  return resolveTrialIdentityKeyring(env);
}

describe('backward compatibility with the single secret', () => {
  /*
   * The whole reason this release can ship without touching production's
   * variables. A deployment that has only ever set `TRIAL_IDENTITY_HMAC_SECRET`
   * must behave exactly as it did: one key, version 1, active — so every claim
   * already in the ledger keeps matching.
   */
  it('reads the legacy variable as version 1 and makes it active', () => {
    const resolved = keyring({ [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: V1 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.activeVersion).toBe(1);
    expect(resolved.supportedVersions).toEqual([1]);
    expect(resolved.secretFor(1)).toBe(V1);
  });

  it('accepts the legacy variable and V1 set to the same key', () => {
    const resolved = keyring({
      [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: V1,
      [trialIdentitySecretVar(1)]: V1,
    });
    expect(resolved.ok).toBe(true);
  });

  /*
   * Two values for one version have two possible meanings — "the new one is a
   * rotation" and "the old one is stale" — and they lead to opposite behaviour.
   * Guessing either way risks writing claims nobody can look up again.
   */
  it('fails closed when the legacy variable and V1 disagree', () => {
    const resolved = keyring({
      [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: V1,
      [trialIdentitySecretVar(1)]: V2,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('legacy-conflict');
    expect(resolved.message).toContain(trialIdentitySecretVar(1));
    // Actionable, and it names variables rather than their contents.
    expect(resolved.message).not.toContain(V1);
    expect(resolved.message).not.toContain(V2);
  });
});

describe('rotating the active version', () => {
  /*
   * The runbook's second step: V2 exists and is deployed, but nothing writes it
   * yet. Defaulting to "the highest key configured" would have started writing V2
   * the moment the variable appeared — before anybody decided to.
   */
  it('keeps writing V1 when a second key is added but not yet made active', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(1)]: V1,
      [trialIdentitySecretVar(2)]: V2,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.activeVersion).toBe(1);
    // …and reads both, which is what keeps the old claims blocking.
    expect(resolved.supportedVersions).toEqual([1, 2]);
  });

  it('writes V2 once the active version says so, and still reads V1', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(1)]: V1,
      [trialIdentitySecretVar(2)]: V2,
      [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: '2',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.activeVersion).toBe(2);
    expect(resolved.supportedVersions).toEqual([1, 2]);
    expect(resolved.secretFor(1)).toBe(V1);
  });

  it('supports every configured version at once, in ascending order', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(1)]: V1,
      [trialIdentitySecretVar(3)]: V3,
      [trialIdentitySecretVar(2)]: V2,
      [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: '3',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.supportedVersions).toEqual([1, 2, 3]);
  });

  /*
   * A gap is legitimate: V1's claims have all aged out and its key was retired,
   * leaving V2 and V3. What is *not* legitimate is assuming which one is active.
   */
  it('requires an explicit active version once V1 has been retired', () => {
    const resolved = keyring({ [trialIdentitySecretVar(2)]: V2 });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('active-version-required');
    expect(resolved.message).toContain(TRIAL_IDENTITY_ACTIVE_VERSION_VAR);
  });

  it('accepts a gap when the active version is named', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(2)]: V2,
      [trialIdentitySecretVar(3)]: V3,
      [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: '3',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.supportedVersions).toEqual([2, 3]);
    expect(resolved.activeVersion).toBe(3);
  });
});

describe('failing closed', () => {
  it('reports no keys at all as its own state rather than an error', () => {
    const resolved = keyring({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('no-keys');
  });

  it('treats an empty or whitespace-only variable as unset', () => {
    for (const value of ['', '   ', '\n']) {
      const resolved = keyring({ [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: value });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.reason).toBe('no-keys');
    }
  });

  /*
   * A padded value is a real value that has been mangled in transit. Honouring it
   * would derive digests nobody can reproduce from the key as it was intended, so
   * it is refused rather than trimmed.
   */
  it('refuses a key with surrounding whitespace instead of trimming it', () => {
    const resolved = keyring({ [trialIdentitySecretVar(1)]: ` ${V1} ` });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('malformed-secret');
    expect(resolved.message).toContain(trialIdentitySecretVar(1));
    expect(resolved.message).not.toContain(V1);
  });

  it('refuses a key shorter than the minimum', () => {
    const resolved = keyring({ [trialIdentitySecretVar(1)]: 'too-short' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('malformed-secret');
  });

  /*
   * Two versions holding one key would write two rows for one identity while the
   * derivations stayed indistinguishable — "rotated" without having rotated.
   */
  it('refuses the same key under two versions', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(1)]: V1,
      [trialIdentitySecretVar(2)]: V1,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('duplicate-secret');
    expect(resolved.message).toContain(trialIdentitySecretVar(2));
  });

  /*
   * The mistake with the worst consequence: flipping the active version before
   * the key it names exists. Every new claim would be unwritable and every
   * lookup would miss, so it refuses outright.
   */
  it('refuses an active version whose key is not set', () => {
    const resolved = keyring({
      [trialIdentitySecretVar(1)]: V1,
      [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: '2',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('active-key-missing');
    expect(resolved.message).toContain(trialIdentitySecretVar(2));
    expect(resolved.message).toContain('before making its version active');
  });

  it('refuses an active version that is not a number in range', () => {
    for (const value of ['zero', '0', '-1', '1.5', String(TRIAL_IDENTITY_MAX_KEY_VERSION + 1)]) {
      const resolved = keyring({
        [trialIdentitySecretVar(1)]: V1,
        [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: value,
      });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.reason).toBe('active-version-invalid');
    }
  });

  it('does not fall back to the legacy key when V1 is present but malformed', () => {
    const resolved = keyring({
      [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: V1,
      [trialIdentitySecretVar(1)]: 'short',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('malformed-secret');
  });
});

describe('what the operator is told', () => {
  it('flags a short-but-usable key as weak without refusing it', () => {
    const resolved = keyring({ [trialIdentitySecretVar(1)]: 'exactly-sixteen!' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.weakVersions).toEqual([1]);
  });

  it('reports nothing weak when every key is comfortably long', () => {
    const resolved = keyring({ [trialIdentitySecretVar(1)]: V1 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.weakVersions).toEqual([]);
  });

  /*
   * No failure message may carry a key. This walks the whole failure matrix and
   * asserts it of every sentence, so a future branch cannot quietly interpolate
   * one.
   */
  it('never puts a key in a failure message', () => {
    const configurations: Array<Record<string, unknown>> = [
      {},
      { [trialIdentitySecretVar(1)]: ` ${V1} ` },
      { [trialIdentitySecretVar(1)]: V1, [trialIdentitySecretVar(2)]: V1 },
      { [LEGACY_TRIAL_IDENTITY_SECRET_VAR]: V1, [trialIdentitySecretVar(1)]: V2 },
      { [trialIdentitySecretVar(1)]: V1, [TRIAL_IDENTITY_ACTIVE_VERSION_VAR]: '4' },
      { [trialIdentitySecretVar(2)]: V2 },
    ];
    for (const configuration of configurations) {
      const resolved = keyring(configuration);
      if (resolved.ok) continue;
      for (const secret of [V1, V2, V3]) expect(resolved.message).not.toContain(secret);
    }
  });
});
