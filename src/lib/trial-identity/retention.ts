/**
 * How long a spent-trial claim is kept, and what is allowed to delete one.
 *
 * These are *policy* numbers, not technical ones, and they are written here as
 * reviewable constants so that changing one is a decision somebody makes rather
 * than a value buried in a cron job. The privacy page reads them directly, so the
 * published promise and the code that keeps it cannot drift apart, and the
 * migration asserts the same numbers on the SQL side.
 *
 * Why three years: the claim exists only to make one free week one free week per
 * person. A window that is too short reopens the loophole on a schedule; a
 * window with no end keeps a pseudonymous record of somebody who left, forever,
 * for a promotion that will not run forever either. Three years is longer than
 * any plausible "I forgot I tried this" gap and short enough to be defensible as
 * proportionate.
 *
 * Three properties are worth stating outright, because each one is a way this
 * could have gone wrong:
 *
 *   * **The deadline is stamped once, when the claim is made**, into
 *     `trial_identity_claims.retain_until`. It is never recomputed. Editing the
 *     policy therefore changes what *future* claims promise and cannot reach back
 *     and shorten a promise already made to somebody who has left — which is
 *     exactly what a purge that computed `first_claimed_at + <current policy>` on
 *     every run would do.
 *   * **Enforcement is off until legal sign-off.** The sweep is scheduled and
 *     runs on time, but with the database flag at its default it reports how many
 *     rows are due and deletes none. See
 *     `docs/operations/trial-retention-enforcement.md`.
 *   * **A legal hold outranks the deadline.** A claim under dispute or audit is
 *     kept past its retention date, and nothing a browser can reach can set,
 *     clear or read that hold.
 */

export const TRIAL_IDENTITY_RETENTION_YEARS = 3;

/** The same period in days, which is what the sweep and the SQL both work in. */
export const TRIAL_IDENTITY_RETENTION_DAYS = TRIAL_IDENTITY_RETENTION_YEARS * 365;

/**
 * Where a claim came from.
 *
 * It exists for one reason: our own Production QA leaves real claims behind, and
 * they must keep blocking a second trial for as long as the test runs while not
 * sitting in the table for three years pretending to be a person. Only a trusted
 * service-role path can write anything other than `user` — a browser cannot
 * reach the ledger at all, let alone label a row with a shorter lifetime.
 *
 *   * `user`        — an ordinary reader's claim, and the value every row that
 *                     predates this column carries. Not a guess about those rows
 *                     so much as the conservative reading of them: `user` is the
 *                     origin with the longest protection and the one no cleanup
 *                     command will touch.
 *   * `backfill`    — written by `scripts/backfill-trial-identities.ts` for an
 *                     account whose trial predates the ledger.
 *   * `production_qa` — created by a Production QA run through the trusted path,
 *                     and the only origin the QA cleanup command may delete.
 */
export const trialClaimOrigins = ['user', 'backfill', 'production_qa'] as const;
export type TrialClaimOrigin = typeof trialClaimOrigins[number];

/**
 * QA claims are kept long enough to prove the ledger works across a release and
 * a re-registration, and no longer. They are our own test data; keeping them for
 * three years would only pad the table.
 */
export const TRIAL_IDENTITY_QA_RETENTION_DAYS = 90;

export function trialIdentityRetentionDays(origin: TrialClaimOrigin): number {
  return origin === 'production_qa' ? TRIAL_IDENTITY_QA_RETENTION_DAYS : TRIAL_IDENTITY_RETENTION_DAYS;
}

/**
 * The instant a claim made now stops being kept.
 *
 * Used to state the policy and to check the migration's backfill against it. The
 * value that actually governs a row is the one stored on that row.
 */
export function trialIdentityRetainUntil(
  firstClaimedAt: string | Date,
  origin: TrialClaimOrigin = 'user',
): string {
  const claimed = firstClaimedAt instanceof Date ? firstClaimedAt.getTime() : Date.parse(firstClaimedAt);
  if (!Number.isFinite(claimed)) throw new Error('TRIAL_IDENTITY_RETAIN_UNTIL_INVALID_DATE');
  return new Date(claimed + trialIdentityRetentionDays(origin) * 86_400_000).toISOString();
}

/**
 * Whether a claim has outlived its stored window.
 *
 * Reads `retain_until` when the row has one and falls back to the policy applied
 * to `first_claimed_at` only when it does not — which, after the migration, is no
 * row at all. A row missing both is reported as *not* expired: an unreadable
 * deadline must never be the reason something is deleted.
 */
export function trialIdentityClaimIsExpired(
  claim: { retainUntil?: string | null; firstClaimedAt?: string | null; legalHoldUntil?: string | null },
  now: number = Date.now(),
): boolean {
  if (trialIdentityClaimIsHeld(claim, now)) return false;

  const stored = typeof claim.retainUntil === 'string' ? Date.parse(claim.retainUntil) : Number.NaN;
  if (Number.isFinite(stored)) return stored < now;

  const claimed = typeof claim.firstClaimedAt === 'string' ? Date.parse(claim.firstClaimedAt) : Number.NaN;
  if (!Number.isFinite(claimed)) return false;
  return now - claimed > TRIAL_IDENTITY_RETENTION_DAYS * 86_400_000;
}

/** Whether a legal hold is still in force, and therefore outranks the deadline. */
export function trialIdentityClaimIsHeld(
  claim: { legalHoldUntil?: string | null },
  now: number = Date.now(),
): boolean {
  const held = typeof claim.legalHoldUntil === 'string' ? Date.parse(claim.legalHoldUntil) : Number.NaN;
  return Number.isFinite(held) && held > now;
}

/**
 * What a sweep is actually going to do.
 *
 * Three outcomes rather than two, because "enforcement is off" is a different
 * thing from "the operator asked for a preview" and an audit row that conflated
 * them would make the record useless: nobody reading it later could tell whether
 * a run deleted nothing because it was told not to or because it was not allowed
 * to.
 */
export type TrialRetentionMode = 'dry_run' | 'reporting_only' | 'apply';

export function resolveTrialRetentionMode(input: {
  apply: boolean;
  enforcementEnabled: boolean;
}): TrialRetentionMode {
  if (!input.apply) return 'dry_run';
  return input.enforcementEnabled ? 'apply' : 'reporting_only';
}

export function trialRetentionModeDeletes(mode: TrialRetentionMode): boolean {
  return mode === 'apply';
}

/**
 * How many rows one run may remove.
 *
 * Bounded at both ends on purpose. A batch is what keeps the sweep from holding a
 * lock across the whole table while a person is trying to start a trial; an
 * unbounded "batch" would be the same table scan with extra steps.
 */
export const TRIAL_RETENTION_DEFAULT_BATCH = 500;
export const TRIAL_RETENTION_MAX_BATCH = 5_000;

export function resolveTrialRetentionBatch(requested: number | null | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return TRIAL_RETENTION_DEFAULT_BATCH;
  const whole = Math.floor(requested);
  if (whole < 1) return 1;
  return Math.min(whole, TRIAL_RETENTION_MAX_BATCH);
}
