import { describe, expect, it } from 'vitest';
import {
  resolveTrialRetentionBatch,
  resolveTrialRetentionMode,
  TRIAL_IDENTITY_QA_RETENTION_DAYS,
  TRIAL_IDENTITY_RETENTION_DAYS,
  TRIAL_IDENTITY_RETENTION_YEARS,
  TRIAL_RETENTION_DEFAULT_BATCH,
  TRIAL_RETENTION_MAX_BATCH,
  trialClaimOrigins,
  trialIdentityClaimIsExpired,
  trialIdentityClaimIsHeld,
  trialIdentityRetainUntil,
  trialIdentityRetentionDays,
  trialRetentionModeDeletes,
} from './retention';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-06T12:00:00.000Z');

describe('the published policy', () => {
  it('is three years, in both units', () => {
    expect(TRIAL_IDENTITY_RETENTION_YEARS).toBe(3);
    expect(TRIAL_IDENTITY_RETENTION_DAYS).toBe(1095);
  });

  it('gives our own QA claims a shorter window than a person\'s', () => {
    expect(TRIAL_IDENTITY_QA_RETENTION_DAYS).toBeLessThan(TRIAL_IDENTITY_RETENTION_DAYS);
    expect(trialIdentityRetentionDays('production_qa')).toBe(TRIAL_IDENTITY_QA_RETENTION_DAYS);
    for (const origin of ['user', 'backfill'] as const) {
      expect(trialIdentityRetentionDays(origin)).toBe(TRIAL_IDENTITY_RETENTION_DAYS);
    }
  });

  it('names exactly the origins the database constraint allows', () => {
    expect([...trialClaimOrigins]).toEqual(['user', 'backfill', 'production_qa']);
  });
});

describe('the stored deadline', () => {
  it('is the claim instant plus the policy for its origin', () => {
    const claimed = '2026-08-06T00:00:00.000Z';
    expect(trialIdentityRetainUntil(claimed)).toBe(
      new Date(Date.parse(claimed) + 1095 * DAY).toISOString(),
    );
    expect(trialIdentityRetainUntil(claimed, 'production_qa')).toBe(
      new Date(Date.parse(claimed) + 90 * DAY).toISOString(),
    );
  });

  it('refuses to invent a deadline from an unreadable claim date', () => {
    expect(() => trialIdentityRetainUntil('not-a-date')).toThrow(/INVALID_DATE/);
  });
});

describe('whether a claim has expired', () => {
  it('reads the stored deadline in preference to recomputing one', () => {
    /*
     * The property that makes a policy change safe. This row's deadline was
     * stamped under a *longer* window than today's policy; the answer must come
     * from the row, so editing the constant cannot retroactively shorten a promise
     * already made.
     */
    const claim = {
      firstClaimedAt: new Date(NOW - 2000 * DAY).toISOString(),
      retainUntil: new Date(NOW + 10 * DAY).toISOString(),
    };
    expect(trialIdentityClaimIsExpired(claim, NOW)).toBe(false);
  });

  it('expires a row whose stored deadline has passed', () => {
    expect(trialIdentityClaimIsExpired({ retainUntil: new Date(NOW - 1).toISOString() }, NOW)).toBe(true);
  });

  it('falls back to the policy only when the row has no deadline at all', () => {
    expect(trialIdentityClaimIsExpired(
      { firstClaimedAt: new Date(NOW - 1096 * DAY).toISOString() },
      NOW,
    )).toBe(true);
    expect(trialIdentityClaimIsExpired(
      { firstClaimedAt: new Date(NOW - 1000 * DAY).toISOString() },
      NOW,
    )).toBe(false);
  });

  /*
   * An unreadable deadline must never be the reason something is deleted. Both
   * halves absent is the one case where "expired" would be a guess.
   */
  it('reports a row with no readable date as not expired', () => {
    expect(trialIdentityClaimIsExpired({}, NOW)).toBe(false);
    expect(trialIdentityClaimIsExpired({ retainUntil: 'nonsense', firstClaimedAt: null }, NOW)).toBe(false);
  });

  it('keeps a row under a live legal hold however old it is', () => {
    const held = {
      retainUntil: new Date(NOW - 500 * DAY).toISOString(),
      legalHoldUntil: new Date(NOW + DAY).toISOString(),
    };
    expect(trialIdentityClaimIsHeld(held, NOW)).toBe(true);
    expect(trialIdentityClaimIsExpired(held, NOW)).toBe(false);
  });

  it('stops holding a row once the hold itself has lapsed', () => {
    const lapsed = {
      retainUntil: new Date(NOW - 500 * DAY).toISOString(),
      legalHoldUntil: new Date(NOW - DAY).toISOString(),
    };
    expect(trialIdentityClaimIsHeld(lapsed, NOW)).toBe(false);
    expect(trialIdentityClaimIsExpired(lapsed, NOW)).toBe(true);
  });
});

describe('what a sweep will do', () => {
  /*
   * Three modes rather than two, because an audit row that could not tell
   * "previewed" from "not permitted" would be unreadable a year later.
   */
  it('previews when the caller did not ask to apply', () => {
    expect(resolveTrialRetentionMode({ apply: false, enforcementEnabled: true })).toBe('dry_run');
    expect(resolveTrialRetentionMode({ apply: false, enforcementEnabled: false })).toBe('dry_run');
  });

  it('reports rather than deletes while enforcement is off', () => {
    expect(resolveTrialRetentionMode({ apply: true, enforcementEnabled: false })).toBe('reporting_only');
  });

  it('deletes only when the caller applied and enforcement is on', () => {
    expect(resolveTrialRetentionMode({ apply: true, enforcementEnabled: true })).toBe('apply');
  });

  it('lets exactly one mode remove a row', () => {
    expect(['dry_run', 'reporting_only', 'apply'].filter(
      (mode) => trialRetentionModeDeletes(mode as 'apply'),
    )).toEqual(['apply']);
  });
});

describe('the batch bound', () => {
  it('defaults when nothing usable was asked for', () => {
    for (const requested of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveTrialRetentionBatch(requested)).toBe(TRIAL_RETENTION_DEFAULT_BATCH);
    }
  });

  it('never returns zero, a negative, or an unbounded batch', () => {
    expect(resolveTrialRetentionBatch(0)).toBe(1);
    expect(resolveTrialRetentionBatch(-50)).toBe(1);
    expect(resolveTrialRetentionBatch(1_000_000)).toBe(TRIAL_RETENTION_MAX_BATCH);
    expect(resolveTrialRetentionBatch(250.7)).toBe(250);
  });
});
