/**
 * The keys the trial ledger is written and read with, as a versioned set.
 *
 * A single secret was enough while it had never been rotated. The moment it is,
 * a one-key deployment has two bad options: keep the old key and never rotate,
 * or replace it and silently stop recognising every claim already in the table —
 * which hands a second free week to every person who ever had one. Neither is
 * acceptable, so the key is plural.
 *
 * The shape of the guarantee:
 *
 *   * **one active version writes.** A new claim is stamped with the active
 *     version and nothing else, so the table never fills with duplicates of one
 *     identity under keys nobody chose.
 *   * **every configured version reads.** Eligibility derives the identity once
 *     per version it holds a key for and asks about all of them at once, so a
 *     claim written under V1 still refuses a trial after the active version has
 *     moved to V2.
 *   * **a version we cannot compute is a refusal, not a pass.** If the ledger
 *     holds a claim stamped with a version this deployment has no key for, there
 *     is no way to tell whether the person in front of us is the person who made
 *     it — and the safe answer to "I cannot tell" is no. That check needs the
 *     database and lives in the store; this module supplies the list of versions
 *     that *are* computable.
 *
 * Every failure here is closed: no key, an active version naming a key that is
 * not set, two versions carrying the same secret, a value the format rules
 * reject. A deployment in any of those states derives nothing, and a trial that
 * cannot be recorded is not granted.
 *
 * No function in this file logs, returns or embeds a secret. Failures carry a
 * fixed reason code and a sentence naming the *variable*, never its value.
 */

/**
 * The highest version the environment schema declares. Going beyond it is one
 * line in `src/config/env/server.ts` plus this constant — deliberately a code
 * change, so a fifth key is a decision somebody makes rather than a variable
 * somebody typed. Four covers a yearly rotation across the whole retention
 * window.
 */
export const TRIAL_IDENTITY_MAX_KEY_VERSION = 4;

/**
 * Short enough to admit the key already in production, long enough that nothing
 * guessable can be one. A key below this is a configuration mistake rather than
 * a weak choice, so it fails closed instead of being accepted quietly.
 */
export const TRIAL_IDENTITY_MIN_SECRET_LENGTH = 16;

/** The length below which a key is reported as weak but still honoured. */
export const TRIAL_IDENTITY_RECOMMENDED_SECRET_LENGTH = 32;

export const LEGACY_TRIAL_IDENTITY_SECRET_VAR = 'TRIAL_IDENTITY_HMAC_SECRET';
export const TRIAL_IDENTITY_ACTIVE_VERSION_VAR = 'TRIAL_IDENTITY_HMAC_ACTIVE_VERSION';

export function trialIdentitySecretVar(version: number): string {
  return `TRIAL_IDENTITY_HMAC_SECRET_V${version}`;
}

export type TrialIdentityKeyringFailure =
  /** Nothing is configured at all. The feature is off, which is a valid state. */
  | 'no-keys'
  /** A value is present but not a usable secret: padded, or too short. */
  | 'malformed-secret'
  /** The legacy variable and `…_V1` are both set and disagree. */
  | 'legacy-conflict'
  /** One secret is configured under two versions, which defeats versioning. */
  | 'duplicate-secret'
  /** The active version is not a whole number inside the declared range. */
  | 'active-version-invalid'
  /** The active version names a key that is not set. */
  | 'active-key-missing'
  /** V1 has been retired, so which version is active can no longer be assumed. */
  | 'active-version-required';

export interface TrialIdentityKeyringOk {
  ok: true;
  /** The version new claims are written under. */
  activeVersion: number;
  /** Every version this deployment can derive, ascending. Includes the active one. */
  supportedVersions: number[];
  /** Versions whose key is shorter than the recommended length. Never a value. */
  weakVersions: number[];
  secretFor(version: number): string | undefined;
}

export interface TrialIdentityKeyringFailed {
  ok: false;
  reason: TrialIdentityKeyringFailure;
  /** Actionable, and free of secrets: it names variables, never their contents. */
  message: string;
}

export type TrialIdentityKeyring = TrialIdentityKeyringOk | TrialIdentityKeyringFailed;

function fail(reason: TrialIdentityKeyringFailure, message: string): TrialIdentityKeyringFailed {
  return { ok: false, reason, message };
}

/**
 * A present value, or nothing.
 *
 * An empty or whitespace-only variable is treated as absent rather than as a
 * malformed key: that is what an unset variable looks like on several hosts, and
 * failing a deployment because a platform wrote `""` would take the feature down
 * for a reason nobody could act on. A value with *surrounding* whitespace is a
 * different matter — it is a real value that has been mangled, and honouring it
 * would derive digests nobody can reproduce.
 */
function present(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Resolve the keyring from an environment record.
 *
 * Pure and total: it takes the variables and returns a decision, so the whole
 * matrix — a rotation half-applied, a retired key, a padded value — is
 * exercisable in a test without a process to restart.
 */
export function resolveTrialIdentityKeyring(
  env: Record<string, unknown>,
): TrialIdentityKeyring {
  const keys = new Map<number, string>();
  const malformed: string[] = [];

  function accept(version: number, raw: string, variable: string): void {
    if (raw !== raw.trim()) {
      malformed.push(`${variable} has leading or trailing whitespace`);
      return;
    }
    if (raw.length < TRIAL_IDENTITY_MIN_SECRET_LENGTH) {
      malformed.push(`${variable} is shorter than ${TRIAL_IDENTITY_MIN_SECRET_LENGTH} characters`);
      return;
    }
    keys.set(version, raw);
  }

  for (let version = 1; version <= TRIAL_IDENTITY_MAX_KEY_VERSION; version += 1) {
    const variable = trialIdentitySecretVar(version);
    const raw = present(env[variable]);
    if (raw !== undefined) accept(version, raw, variable);
  }

  /*
   * The variable this feature shipped with, read as version 1.
   *
   * This is the whole of the backward compatibility: a production that has only
   * ever set `TRIAL_IDENTITY_HMAC_SECRET` resolves to exactly the keyring it
   * behaved as before — one key, version 1, active — and every claim already in
   * the table keeps matching. Setting `…_V1` to the same value is the migration
   * step, and setting it to a *different* value is refused rather than guessed
   * at, because the two answers ("the new one is a rotation" and "the old one is
   * stale") lead to opposite behaviour and only the operator knows which is meant.
   */
  const legacy = present(env[LEGACY_TRIAL_IDENTITY_SECRET_VAR]);
  if (legacy !== undefined) {
    const explicit = keys.get(1);
    if (explicit === undefined) {
      const raw = present(env[trialIdentitySecretVar(1)]);
      // V1 was supplied but rejected as malformed; do not paper over it with the
      // legacy value, or the deployment would run on a key the operator replaced.
      if (raw === undefined) accept(1, legacy, LEGACY_TRIAL_IDENTITY_SECRET_VAR);
    } else if (explicit !== legacy) {
      return fail(
        'legacy-conflict',
        `${LEGACY_TRIAL_IDENTITY_SECRET_VAR} and ${trialIdentitySecretVar(1)} are both set to different `
        + `values. Version 1 must mean one key: set ${trialIdentitySecretVar(1)} to the value version 1 `
        + `claims were written with, and put any new key on a new version instead.`,
      );
    }
  }

  if (malformed.length > 0) {
    return fail('malformed-secret', `Trial identity keys are unusable: ${malformed.join('; ')}.`);
  }
  if (keys.size === 0) return fail('no-keys', 'No trial identity key is configured.');

  /*
   * One secret under two versions would write two rows for one identity and make
   * the version stamp a lie — the two would be indistinguishable derivations, so
   * "rotate" would have changed nothing while looking like it had.
   */
  const bySecret = new Map<string, number>();
  for (const [version, secret] of [...keys].sort((left, right) => left[0] - right[0])) {
    const first = bySecret.get(secret);
    if (first !== undefined) {
      return fail(
        'duplicate-secret',
        `${trialIdentitySecretVar(first)} and ${trialIdentitySecretVar(version)} hold the same key. `
        + 'Each version must be a distinct key, or rotating one changes nothing.',
      );
    }
    bySecret.set(secret, version);
  }

  const declaredActive = present(env[TRIAL_IDENTITY_ACTIVE_VERSION_VAR]);
  let activeVersion: number;
  if (declaredActive === undefined) {
    /*
     * Not "the highest key configured". Adding a key must be deployable on its
     * own — the rotation runbook adds V2, ships a build that can *read* it, and
     * only then makes it active — and a default of "highest" would start writing
     * V2 the moment the variable appeared, before anybody decided to.
     */
    if (!keys.has(1)) {
      return fail(
        'active-version-required',
        `Version 1 is not configured, so ${TRIAL_IDENTITY_ACTIVE_VERSION_VAR} must name the version new `
        + 'claims are written under.',
      );
    }
    activeVersion = 1;
  } else {
    if (!/^\d{1,3}$/.test(declaredActive.trim())) {
      return fail(
        'active-version-invalid',
        `${TRIAL_IDENTITY_ACTIVE_VERSION_VAR} must be a whole number between 1 and `
        + `${TRIAL_IDENTITY_MAX_KEY_VERSION}.`,
      );
    }
    activeVersion = Number.parseInt(declaredActive.trim(), 10);
    if (activeVersion < 1 || activeVersion > TRIAL_IDENTITY_MAX_KEY_VERSION) {
      return fail(
        'active-version-invalid',
        `${TRIAL_IDENTITY_ACTIVE_VERSION_VAR} is ${activeVersion}, outside the declared range 1 to `
        + `${TRIAL_IDENTITY_MAX_KEY_VERSION}.`,
      );
    }
    if (!keys.has(activeVersion)) {
      return fail(
        'active-key-missing',
        `${TRIAL_IDENTITY_ACTIVE_VERSION_VAR} is ${activeVersion} but ${trialIdentitySecretVar(activeVersion)} `
        + 'is not set. Set the key before making its version active.',
      );
    }
  }

  const supportedVersions = [...keys.keys()].sort((left, right) => left - right);
  const weakVersions = supportedVersions.filter(
    (version) => (keys.get(version) as string).length < TRIAL_IDENTITY_RECOMMENDED_SECRET_LENGTH,
  );

  return {
    ok: true,
    activeVersion,
    supportedVersions,
    weakVersions,
    secretFor: (version: number) => keys.get(version),
  };
}
