/**
 * Finding a deletion that stopped, and deciding what is safe to do about it.
 *
 * The pipeline in `account-deletion.ts` is resumable and every step is idempotent,
 * which is worth nothing on its own: an account whose data is purged but whose
 * auth user survived a failed `deleteUser` looks, to every ordinary query, exactly
 * like an account. Nobody would know to re-run anything. So there are two pieces
 * here — a report that names the state, and a rule that says which states may be
 * carried forward without a person deciding.
 *
 * The rules, and what each one is protecting against:
 *
 *   * **Never back to active past the point of no return.** An account whose data
 *     is half gone must not be handed to its owner as though it were intact. Only
 *     the database's own `cancel_account_deletion` can revert, and only at the
 *     stage where nothing has been destroyed — this module never asks it to.
 *   * **Never repeat a destructive first-time action.** A second provider
 *     cancellation, a second ledger write, a second purge of rows already gone:
 *     the first two are outward-facing and the third is pointless. Resumption
 *     starts at the earliest step that is *safe to repeat* for the stage reached,
 *     and `requested` is deliberately not resumable here at all — settling a
 *     payment provider needs the billing configuration and the application's own
 *     provider client, so it belongs to the in-app pipeline, which is safe to
 *     re-run from the top.
 *   * **Never delete an auth user on a claim alone.** `data_purged` is a statement
 *     about the past. Before the last step runs, the present is measured: the
 *     account must still exist, and it must own zero rows. A lifecycle row that
 *     says purged while rows remain is a contradiction, and the answer to a
 *     contradiction is to stop and report it.
 *
 * Pure: it takes a report row and returns a decision. Nothing here reads a
 * database, and nothing here logs — the script that drives it does both, and logs
 * a stage and an account id, never an address.
 */

/** The states a deletion in progress can be observed in. */
export type AccountDeletionState =
  /** Nothing destroyed yet. The in-app pipeline may be re-run, or it may cancel. */
  | 'closing'
  /** The provider is settled, so the only way out is forward. */
  | 'purge_pending'
  /** The data is gone and the auth user is not. What a failed delete leaves. */
  | 'awaiting_auth_delete';

export interface AccountDeletionReportRow {
  userId: string;
  state: AccountDeletionState;
  stage: string | null;
  operationId: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  stuck: boolean;
  residualRows: number;
  authUserExists: boolean;
}

/** What a reconciler may do with one row, and why. */
export type AccountDeletionAction =
  /** Re-run `purge_account_data` and the storage sweep, then advance the stage. */
  | 'resume-purge'
  /** Delete the auth user, the last step, now that the purge is proved complete. */
  | 'delete-auth-user'
  /** Nothing to do: the row describes a finished or self-resolving state. */
  | 'none'
  /**
   * A person has to look. Either the state needs the in-app pipeline (a provider
   * still to settle) or it contradicts itself.
   */
  | 'report-only';

export interface AccountDeletionDecision {
  userId: string;
  action: AccountDeletionAction;
  /** Fixed, operator-facing, and free of anything about the person. */
  reason: string;
}

/**
 * A `residual_rows` we could not read is not zero.
 *
 * Checked before the decision rather than trusted inside it, because it is the one
 * input whose absence would turn the most dangerous action into the default:
 * `NaN > 0` is false, so a missing count would sail past the contradiction check
 * below and authorise deleting an auth user on no evidence at all.
 */
export function residualCountIsProved(row: { residualRows: number }): boolean {
  return Number.isInteger(row.residualRows) && row.residualRows >= 0;
}

/**
 * The one place that decides. Every branch is a refusal except two.
 */
export function decideAccountDeletionRecovery(
  row: AccountDeletionReportRow,
): AccountDeletionDecision {
  const decision = (action: AccountDeletionAction, reason: string): AccountDeletionDecision =>
    ({ userId: row.userId, action, reason });

  /*
   * The auth user is already gone, so the deletion finished and only the
   * lifecycle row is behind — and it cascades from `auth.users`, so a row without
   * a user is a state the database should not be able to hold. Report it; do not
   * invent a repair for a row nothing can explain.
   */
  if (!row.authUserExists) {
    return decision('report-only', 'lifecycle row without an auth user');
  }

  switch (row.state) {
    case 'closing':
      /*
       * Nothing has been destroyed, which means the payment provider has not been
       * settled either — and settling it is the one step a reconciler cannot do
       * without the application's billing client. The in-app pipeline is safe to
       * re-run from the top, so that is the instruction, not an action taken here.
       */
      return decision('report-only', 'provider not settled; re-run the in-app deletion');

    case 'purge_pending':
      /*
       * The provider is settled and the data is not yet gone. `purge_account_data`
       * is idempotent and the ledger was written before the provider was settled,
       * so resuming here repeats nothing outward-facing and re-writes no claim.
       */
      return decision('resume-purge', 'provider settled; purge is safe to repeat');

    case 'awaiting_auth_delete':
      if (!residualCountIsProved(row)) {
        return decision('report-only', 'residual row count unreadable');
      }
      if (row.residualRows > 0) {
        /*
         * The stage claims the data is gone and it is not. Something removed the
         * rows partially, or a table was added after the purge list was written.
         * Deleting the auth user now would orphan whatever is left, so it stops.
         */
        return decision('report-only', 'stage says purged but rows remain');
      }
      return decision('delete-auth-user', 'purge verified empty; auth user is the last step');

    default:
      return decision('report-only', 'unrecognised state');
  }
}

/**
 * Map a raw report row onto the shape above.
 *
 * Written deliberately defensively: an unrecognised `state` becomes `closing`,
 * the most conservative reading, because `closing` is the one state whose
 * decision takes no action at all. A report row we cannot parse must never
 * promote itself into a row we would act on.
 */
export function parseAccountDeletionReportRow(raw: unknown): AccountDeletionReportRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const userId = typeof row.user_id === 'string' ? row.user_id : null;
  if (!userId) return null;

  const state: AccountDeletionState =
    row.state === 'awaiting_auth_delete' || row.state === 'purge_pending'
      ? row.state
      : 'closing';

  return {
    userId,
    state,
    stage: typeof row.stage === 'string' ? row.stage : null,
    operationId: typeof row.operation_id === 'string' ? row.operation_id : null,
    requestedAt: typeof row.requested_at === 'string' ? row.requested_at : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    stuck: row.stuck === true,
    residualRows: typeof row.residual_rows === 'number' ? row.residual_rows : Number.NaN,
    authUserExists: row.auth_user_exists === true,
  };
}

/**
 * Summarise a report for an operator.
 *
 * Counts by state and by actionability, so the answer to "is anything wrong?" is
 * one line rather than a table somebody has to read.
 */
export function summarizeAccountDeletionReport(rows: readonly AccountDeletionReportRow[]): {
  total: number;
  stuck: number;
  byState: Record<AccountDeletionState, number>;
  actionable: number;
  needsAttention: number;
} {
  const byState: Record<AccountDeletionState, number> = {
    closing: 0,
    purge_pending: 0,
    awaiting_auth_delete: 0,
  };
  let stuck = 0;
  let actionable = 0;
  let needsAttention = 0;

  for (const row of rows) {
    byState[row.state] += 1;
    if (row.stuck) stuck += 1;
    const { action } = decideAccountDeletionRecovery(row);
    if (action === 'resume-purge' || action === 'delete-auth-user') actionable += 1;
    if (action === 'report-only') needsAttention += 1;
  }

  return { total: rows.length, stuck, byState, actionable, needsAttention };
}
