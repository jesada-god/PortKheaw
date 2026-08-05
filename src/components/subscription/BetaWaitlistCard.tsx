import Link from 'next/link';
import { Hourglass } from 'lucide-react';
import type { BetaAccessReason, BetaStage } from '@/src/lib/beta/beta-stages';
import { betaWaitlistCopy } from '@/src/lib/beta/beta-stages';

/**
 * What a reader outside the current rollout stage sees instead of plan cards.
 *
 * It is deliberately not an error. Nothing is broken, nothing is wrong with their
 * account, and they have not been refused anything they had — so the card says
 * what is true (a limited rollout), what still works (everything they already
 * have), and what happens next. A bare "unavailable" would read as a fault and
 * send a perfectly happy reader to support.
 *
 * The support link is shown only where support could actually help: a reader who
 * believes they already paid, or who was invited and cannot get in. Offering it
 * to everybody would turn a rollout into a ticket queue.
 */
export function BetaWaitlistCard({
  reason,
  stage,
}: {
  reason: BetaAccessReason;
  stage: BetaStage;
}) {
  const copy = betaWaitlistCopy(reason, stage);

  return (
    <section
      aria-labelledby="beta-waitlist-heading"
      data-testid="beta-waitlist"
      className="min-w-0 space-y-3 rounded-3xl border border-[var(--border-strong)] bg-[var(--surface-elevated)] p-5 sm:p-7"
    >
      <div className="flex items-start gap-2.5">
        <Hourglass aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0 space-y-2">
          <h2 id="beta-waitlist-heading" className="text-lg font-bold text-[var(--text)]">
            {copy.title}
          </h2>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">{copy.body}</p>
          {copy.supportHint && (
            <p className="text-sm leading-6 text-[var(--text-muted)]">
              {copy.supportHint}{' '}
              <Link
                href="/support"
                className="underline underline-offset-4 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                ติดต่อทีมงาน
              </Link>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
