import { describe, expect, it } from 'vitest';
import {
  decideAccountDeletionRecovery,
  parseAccountDeletionReportRow,
  residualCountIsProved,
  summarizeAccountDeletionReport,
  type AccountDeletionReportRow,
} from './deletion-recovery';

/**
 * What a reconciler is allowed to do to a deletion that stopped.
 *
 * Each refusal here is protecting against a specific, expensive mistake: charging
 * somebody twice by re-cancelling a subscription, handing a half-emptied account
 * back to its owner as though it were intact, or deleting an auth user while rows
 * that belong to it are still in the database.
 */

const ROW: AccountDeletionReportRow = {
  userId: '11111111-1111-4111-8111-111111111111',
  state: 'awaiting_auth_delete',
  stage: 'data_purged',
  operationId: '22222222-2222-4222-8222-222222222222',
  requestedAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:05:00.000Z',
  stuck: true,
  residualRows: 0,
  authUserExists: true,
};

const row = (overrides: Partial<AccountDeletionReportRow>): AccountDeletionReportRow =>
  ({ ...ROW, ...overrides });

describe('what may be resumed', () => {
  /*
   * The genuinely stuck case, and the only one where the last destructive step is
   * taken automatically: the data is gone, the account is not, and the purge has
   * been *measured* complete rather than merely claimed by a stage name.
   */
  it('finishes a deletion whose purge is proved empty', () => {
    expect(decideAccountDeletionRecovery(row({}))).toMatchObject({ action: 'delete-auth-user' });
  });

  /*
   * The provider is settled, so resuming repeats nothing outward-facing — the
   * ledger was written before the provider was, and `purge_account_data` is
   * idempotent by construction.
   */
  it('resumes the purge once the provider is settled', () => {
    expect(decideAccountDeletionRecovery(row({ state: 'purge_pending', stage: 'provider_settled' })))
      .toMatchObject({ action: 'resume-purge' });
  });
});

describe('what may not', () => {
  /*
   * Settling a payment provider needs the application's billing client, and doing
   * it twice is a second outward-facing action against somebody's subscription.
   * The in-app pipeline is safe to re-run from the top; this is not the thing to
   * re-run it with.
   */
  it('refuses to act while the provider is unsettled, and says what to run instead', () => {
    const decision = decideAccountDeletionRecovery(row({ state: 'closing', stage: 'requested' }));
    expect(decision.action).toBe('report-only');
    expect(decision.reason).toContain('re-run the in-app deletion');
  });

  /*
   * The contradiction that must stop everything: the stage claims the data is
   * gone and rows remain. Deleting the auth user now would orphan them.
   */
  it('refuses to delete an auth user while rows remain', () => {
    const decision = decideAccountDeletionRecovery(row({ residualRows: 4 }));
    expect(decision.action).toBe('report-only');
    expect(decision.reason).toContain('rows remain');
  });

  /*
   * The most dangerous default in the file. `NaN > 0` is false, so an unreadable
   * count would otherwise sail past the check above and authorise the deletion on
   * no evidence at all.
   */
  it('refuses to delete an auth user on an unreadable row count', () => {
    for (const residualRows of [Number.NaN, -1, 1.5]) {
      const candidate = row({ residualRows });
      expect(residualCountIsProved(candidate)).toBe(false);
      expect(decideAccountDeletionRecovery(candidate)).toMatchObject({
        action: 'report-only',
        reason: 'residual row count unreadable',
      });
    }
  });

  it('refuses a lifecycle row whose account no longer exists', () => {
    const decision = decideAccountDeletionRecovery(row({ authUserExists: false }));
    expect(decision.action).toBe('report-only');
    expect(decision.reason).toContain('without an auth user');
  });

  /*
   * There is no branch that returns an account to service. Reverting is the
   * database's decision and only at the stage where nothing has been destroyed;
   * nothing here may ask for it.
   */
  it('never proposes returning an account to service', () => {
    const everyState = ['closing', 'purge_pending', 'awaiting_auth_delete'] as const;
    for (const state of everyState) {
      for (const residualRows of [0, 3]) {
        for (const authUserExists of [true, false]) {
          const decision = decideAccountDeletionRecovery(row({ state, residualRows, authUserExists }));
          expect(['resume-purge', 'delete-auth-user', 'report-only', 'none'])
            .toContain(decision.action);
          expect(JSON.stringify(decision)).not.toMatch(/activ|cancel|restore/i);
        }
      }
    }
  });

  it('carries nothing about the person in its reason', () => {
    for (const state of ['closing', 'purge_pending', 'awaiting_auth_delete'] as const) {
      const decision = decideAccountDeletionRecovery(row({ state }));
      expect(decision.reason).not.toContain('@');
      expect(decision.reason).not.toContain(ROW.userId);
    }
  });
});

describe('reading a report row', () => {
  it('maps the database\'s own column names', () => {
    const parsed = parseAccountDeletionReportRow({
      user_id: ROW.userId,
      state: 'awaiting_auth_delete',
      stage: 'data_purged',
      operation_id: ROW.operationId,
      requested_at: ROW.requestedAt,
      updated_at: ROW.updatedAt,
      stuck: true,
      residual_rows: 0,
      auth_user_exists: true,
    });
    expect(parsed).toEqual(ROW);
  });

  /*
   * An unrecognised state becomes `closing`, whose decision takes no action. A row
   * we cannot parse must never promote itself into a row we would act on.
   */
  it('reads an unrecognised state as the one that does nothing', () => {
    const parsed = parseAccountDeletionReportRow({ user_id: ROW.userId, state: 'something_new' });
    expect(parsed?.state).toBe('closing');
    expect(decideAccountDeletionRecovery(parsed as AccountDeletionReportRow).action).toBe('report-only');
  });

  it('reads a missing row count as unproved rather than as zero', () => {
    const parsed = parseAccountDeletionReportRow({
      user_id: ROW.userId, state: 'awaiting_auth_delete', auth_user_exists: true,
    });
    expect(residualCountIsProved(parsed as AccountDeletionReportRow)).toBe(false);
    expect(decideAccountDeletionRecovery(parsed as AccountDeletionReportRow).action).toBe('report-only');
  });

  it('rejects a row with no account at all', () => {
    expect(parseAccountDeletionReportRow({ state: 'closing' })).toBeNull();
    expect(parseAccountDeletionReportRow(null)).toBeNull();
    expect(parseAccountDeletionReportRow('nonsense')).toBeNull();
  });
});

describe('the operator\'s summary', () => {
  it('counts by state and by what can actually be done', () => {
    const summary = summarizeAccountDeletionReport([
      row({ state: 'closing', stuck: true }),
      row({ state: 'purge_pending', stuck: false }),
      row({ state: 'awaiting_auth_delete', residualRows: 0 }),
      row({ state: 'awaiting_auth_delete', residualRows: 9 }),
    ]);
    expect(summary).toEqual({
      total: 4,
      stuck: 3,
      byState: { closing: 1, purge_pending: 1, awaiting_auth_delete: 2 },
      actionable: 2,
      needsAttention: 2,
    });
  });

  it('reports an empty report as empty rather than as a problem', () => {
    expect(summarizeAccountDeletionReport([])).toMatchObject({
      total: 0, stuck: 0, actionable: 0, needsAttention: 0,
    });
  });
});
