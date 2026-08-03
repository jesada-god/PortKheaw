import { FlaskConical, ShieldCheck } from 'lucide-react';
import type { AccountPlanSummary as AccountPlanSummaryState } from '@/src/lib/subscription/account-plan-summary';

/**
 * The two-line answer to "what do I have?".
 *
 * The first line is always the subscription — the thing a reader is billed for.
 * The second appears only when access came from somewhere other than that
 * subscription, and it names where. Keeping them as two labelled statements
 * rather than one merged plan line is the whole point: an administrator reading
 * their own profile has to be able to see that their card has not been charged.
 *
 * Every string arrives already resolved, so this component decides nothing and
 * the wording cannot drift between the profile and the subscription centre.
 */
export function AccountPlanSummary({ summary }: { summary: AccountPlanSummaryState }) {
  const AccessIcon = summary.access?.kind === 'preview' ? FlaskConical : ShieldCheck;

  return (
    <div className="min-w-0 space-y-3">
      <div className="min-w-0">
        <p data-testid="actual-plan-heading" className="text-xs font-medium tracking-wide text-[var(--text-muted)]">
          {summary.actualPlanHeading}
        </p>
        <p data-testid="actual-plan-value" className="mt-1 text-lg font-semibold break-words text-[var(--text)]">
          {summary.actualPlanName}
        </p>
      </div>

      {summary.access && (
        <div
          data-testid="access-line"
          data-access-kind={summary.access.kind}
          className="min-w-0 border-t border-[var(--border)] pt-3"
        >
          <p data-testid="access-heading" className="text-xs font-medium tracking-wide text-[var(--text-muted)]">
            {summary.access.heading}
          </p>
          <p className="mt-1 flex min-w-0 items-start gap-2">
            <AccessIcon aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--role-admin-text)]" />
            <span data-testid="access-value" className="min-w-0 text-sm leading-6 font-medium break-words text-[var(--text)]">
              {summary.access.value}
            </span>
          </p>
          {summary.access.note && (
            <p data-testid="access-note" className="mt-1.5 text-xs leading-5 text-[var(--text-secondary)]">
              {summary.access.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
