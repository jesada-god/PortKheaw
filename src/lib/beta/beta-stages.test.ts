import { describe, expect, it } from 'vitest';
import {
  BETA_CAP_BANDS, BETA_STAGE_LABEL, UNKNOWN_BETA_ACCESS, betaStages, betaWaitlistCopy,
  capChoices, capIsInBand, normalizeBetaStage, resolveBetaAccess, stageAcceptsCap,
} from './beta-stages';

/**
 * The rollout rule, exercised where it is cheap.
 *
 * The database holds the authoritative copy and is tested against a real
 * Postgres in `admin-beta-migration.test.ts`. These cover the same decisions in
 * the pure copy, because a disagreement between the two shows up as a page
 * offering a purchase the server then refuses — or, far worse, the reverse.
 */

describe('stage vocabulary', () => {
  it('fails closed on anything it does not recognise', () => {
    expect(normalizeBetaStage('public')).toBe('public');
    expect(normalizeBetaStage('PUBLIC')).toBe('closed');
    expect(normalizeBetaStage(undefined)).toBe('closed');
    expect(normalizeBetaStage(null)).toBe('closed');
    expect(normalizeBetaStage('beta_100')).toBe('closed');
    // The failure mode of an unreadable stage must be a refusal, never an
    // accidental public launch.
    expect(normalizeBetaStage({ stage: 'public' })).toBe('closed');
  });

  it('names every stage for an operator', () => {
    for (const stage of betaStages) {
      expect(BETA_STAGE_LABEL[stage].length).toBeGreaterThan(0);
    }
  });
});

describe('cohort caps', () => {
  it('carries the band each stage name promises', () => {
    expect(BETA_CAP_BANDS.beta_5_10).toEqual({ min: 5, max: 10 });
    expect(BETA_CAP_BANDS.beta_20_50).toEqual({ min: 20, max: 50 });
  });

  it('offers a cohort size only where a cohort exists', () => {
    expect(stageAcceptsCap('beta_5_10')).toBe(true);
    expect(stageAcceptsCap('beta_20_50')).toBe(true);
    expect(stageAcceptsCap('closed')).toBe(false);
    expect(stageAcceptsCap('public')).toBe(false);
    expect(capChoices('beta_5_10')).toEqual([5, 6, 7, 8, 9, 10]);
    expect(capChoices('public')).toEqual([]);
  });

  it('refuses a size outside the band, in either direction', () => {
    expect(capIsInBand('beta_5_10', 5)).toBe(true);
    expect(capIsInBand('beta_5_10', 10)).toBe(true);
    expect(capIsInBand('beta_5_10', 4)).toBe(false);
    expect(capIsInBand('beta_5_10', 11)).toBe(false);
    expect(capIsInBand('beta_5_10', 7.5)).toBe(false);
    expect(capIsInBand('beta_20_50', 50)).toBe(true);
    expect(capIsInBand('beta_20_50', 51)).toBe(false);
  });

  it('takes no cohort size for the two stages that have none', () => {
    expect(capIsInBand('closed', null)).toBe(true);
    expect(capIsInBand('closed', 5)).toBe(false);
    expect(capIsInBand('public', null)).toBe(true);
    expect(capIsInBand('public', 1000)).toBe(false);
  });
});

describe('who may start a purchase', () => {
  const base = {
    isAdmin: false, invited: false, preExisting: false, subscriber: false, authenticated: true,
  };

  it('admits an operator in every stage', () => {
    for (const stage of betaStages) {
      const result = resolveBetaAccess({ ...base, stage, isAdmin: true });
      expect(result.admitted).toBe(true);
      expect(result.reason).toBe('admin');
    }
  });

  it('admits everybody once the stage is public', () => {
    expect(resolveBetaAccess({ ...base, stage: 'public' })).toEqual({
      stage: 'public', admitted: true, reason: 'public_stage',
    });
  });

  it('never takes anything away from an account that already existed', () => {
    // The non-regression rule, checked in the harshest stage there is.
    for (const stage of betaStages) {
      expect(resolveBetaAccess({ ...base, stage, preExisting: true }).admitted).toBe(true);
      expect(resolveBetaAccess({ ...base, stage, subscriber: true }).admitted).toBe(true);
    }
  });

  it('refuses a new, uninvited account in a cohort stage', () => {
    expect(resolveBetaAccess({ ...base, stage: 'beta_5_10' })).toEqual({
      stage: 'beta_5_10', admitted: false, reason: 'not_invited',
    });
    expect(resolveBetaAccess({ ...base, stage: 'closed' })).toEqual({
      stage: 'closed', admitted: false, reason: 'closed_stage',
    });
  });

  it('admits an invited account in a cohort stage but not in a closed one', () => {
    expect(resolveBetaAccess({ ...base, stage: 'beta_20_50', invited: true }).reason).toBe('invited');
    // `closed` means closed. An invitation issued for a cohort does not survive
    // the programme being shut, and the copy says so.
    expect(resolveBetaAccess({ ...base, stage: 'closed', invited: true }).admitted).toBe(false);
  });

  it('refuses a caller with no session, in every stage but public', () => {
    for (const stage of betaStages) {
      const result = resolveBetaAccess({ ...base, stage, authenticated: false });
      expect(result.admitted).toBe(false);
      expect(result.reason).toBe('unauthenticated');
    }
  });

  it('prefers the most specific reason when several apply', () => {
    // An invited account that also already pays is described as invited: it is
    // the fact the operator acted on.
    expect(resolveBetaAccess({
      ...base, stage: 'beta_5_10', invited: true, subscriber: true, preExisting: true,
    }).reason).toBe('invited');
  });
});

describe('an unreadable programme fails open', () => {
  it('admits, because a rollout flag must not close a shop that is already open', () => {
    expect(UNKNOWN_BETA_ACCESS.admitted).toBe(true);
    expect(UNKNOWN_BETA_ACCESS.reason).toBe('unconfigured');
    expect(UNKNOWN_BETA_ACCESS.isAdmin).toBe(false);
  });
});

describe('what a waiting reader is told', () => {
  it('never reads as a fault, and never blames the account', () => {
    for (const stage of betaStages) {
      for (const reason of ['closed_stage', 'not_invited'] as const) {
        const copy = betaWaitlistCopy(reason, stage);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body).toMatch(/ใช้งาน|แจ้งให้ทราบ|ได้รับเชิญ/);
        // No error vocabulary: nothing has gone wrong for this reader.
        expect(copy.body).not.toMatch(/ผิดพลาด|ล้มเหลว|ขัดข้อง/);
      }
    }
  });

  it('offers support only where support could actually help', () => {
    expect(betaWaitlistCopy('not_invited', 'beta_5_10').supportHint).toContain('ได้รับคำเชิญ');
    expect(betaWaitlistCopy('closed_stage', 'closed').supportHint).toContain('ชำระเงิน');
    // Signing in is the step that changes the outcome, so nothing else is offered.
    expect(betaWaitlistCopy('unauthenticated', 'closed').supportHint).toBe('');
  });

  it('tells a signed-out reader to sign in rather than to wait', () => {
    expect(betaWaitlistCopy('unauthenticated', 'public').title).toContain('เข้าสู่ระบบ');
  });
});
