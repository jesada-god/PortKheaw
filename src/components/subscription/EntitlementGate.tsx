'use client';

import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { PLAN_DISPLAY_NAME, upgradeCopy, upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { useEntitlement } from './EntitlementProvider';

export interface EntitlementGateProps {
  capability: SubscriptionCapability;
  /** Where the prompt came from, for telemetry. e.g. `chart.sr-context`. */
  source: string;
  /** Rendered only when the reader holds the capability. */
  children: ReactNode;
  /**
   * What stands in its place otherwise. Omit for the default locked notice.
   * A replacement must never be the real content behind a visual treatment —
   * blur, opacity and `hidden` are not gates, and nothing locked is rendered.
   */
  fallback?: ReactNode;
  /** Compact form for a locked table row or an inline stat. */
  variant?: 'panel' | 'row';
  className?: string;
}

/**
 * Replace a premium surface with a locked one.
 *
 * The gate renders one branch or the other — never both. The locked branch
 * contains no premium value at all, so there is nothing in the DOM, the RSC
 * payload or a screenshot for CSS to have to hide. It is a presentation gate:
 * the value it protects is withheld by the server, and this only decides what
 * the reader sees in its place.
 */
export function EntitlementGate({
  capability,
  source,
  children,
  fallback,
  variant = 'panel',
  className,
}: EntitlementGateProps) {
  const { can } = useEntitlement();
  if (can(capability)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return <LockedNotice capability={capability} source={source} variant={variant} className={className} />;
}

export interface LockedNoticeProps {
  capability: SubscriptionCapability;
  source: string;
  variant?: 'panel' | 'row';
  className?: string;
  /** Overrides the default one-line placeholder copy. */
  label?: string;
}

/**
 * The default stand-in: what is locked, and the plan that opens it. The whole
 * notice is the button, so a reader on a phone has one large target rather than
 * a sentence with a link buried in it.
 */
export function LockedNotice({ capability, source, variant = 'panel', className, label }: LockedNoticeProps) {
  const { requestUpgrade } = useEntitlement();
  const copy = upgradeCopy(capability);
  const tier = upgradeTargetTier(capability);
  const text = label ?? copy.lockedLabel;

  return (
    <button
      type="button"
      onClick={() => requestUpgrade({ capability, source })}
      data-testid={`locked-${capability}`}
      data-capability={capability}
      data-required-tier={tier}
      aria-label={`${copy.title} — ต้องใช้แพ็กเกจ ${PLAN_DISPLAY_NAME[tier]}`}
      className={[
        'flex w-full min-w-0 items-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-elevated)] text-left text-[var(--text-secondary)] motion-safe:transition-colors hover:border-[var(--accent)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
        variant === 'row' ? 'min-h-9 px-2.5 py-1 text-[11px]' : 'min-h-11 px-3 py-2.5 text-xs',
        className ?? '',
      ].join(' ')}
    >
      <Lock aria-hidden="true" size={variant === 'row' ? 12 : 15} className="shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0 break-words">{text}</span>
    </button>
  );
}
