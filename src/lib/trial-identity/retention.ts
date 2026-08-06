/**
 * How long a spent-trial claim is kept.
 *
 * This is a *policy* number, not a technical one, and it is written here as one
 * reviewable constant so that changing it is a decision somebody makes rather
 * than a value buried in a cron job. The privacy page reads it directly, so the
 * published promise and the code that keeps it cannot drift apart.
 *
 * Why three years: the claim exists only to make one free week one free week per
 * person. A window that is too short reopens the loophole on a schedule; a
 * window with no end keeps a pseudonymous record of somebody who left, forever,
 * for a promotion that will not run forever either. Three years is longer than
 * any plausible "I forgot I tried this" gap and short enough to be defensible as
 * proportionate.
 *
 * **Nothing enforces this yet.** There is no scheduled purge in this release —
 * the number is published, the column it would run against
 * (`trial_identity_claims.first_claimed_at`) exists, and the sweep is deliberate
 * follow-up work. Enabling it, and the retention period itself, should be
 * confirmed with legal counsel against PDPA before it is treated as a
 * commitment.
 */
export const TRIAL_IDENTITY_RETENTION_YEARS = 3;

/** The same period in days, for a sweep that is scheduled rather than described. */
export const TRIAL_IDENTITY_RETENTION_DAYS = TRIAL_IDENTITY_RETENTION_YEARS * 365;

/** Whether a claim first made at this instant has outlived the retention window. */
export function trialIdentityClaimIsExpired(
  firstClaimedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof firstClaimedAt !== 'string') return false;
  const claimed = Date.parse(firstClaimedAt);
  if (!Number.isFinite(claimed)) return false;
  return now - claimed > TRIAL_IDENTITY_RETENTION_DAYS * 86_400_000;
}
