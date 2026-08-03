'use client';

import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { PLAN_DISPLAY_NAME, upgradeCopy, upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { useEntitlement } from './EntitlementProvider';

export interface LockedFeatureButtonProps {
  capability: SubscriptionCapability;
  source: string;
  children: ReactNode;
  /** Runs only when the reader holds the capability. */
  onActivate(): void;
  /** Reflected on the real control; a locked control is never `aria-pressed`. */
  pressed?: boolean;
  className?: string;
  lockedClassName?: string;
  'data-testid'?: string;
  /** True when the control is unusable for a reason that is not entitlement. */
  disabled?: boolean;
  'aria-describedby'?: string;
}

/**
 * A control that stays visible when it is locked.
 *
 * Hiding a premium control teaches nobody it exists; disabling it leaves a dead
 * target that says nothing. So the button keeps its place and its label, gains a
 * padlock, and — this is the point — its click opens the upgrade prompt instead
 * of running the feature. `onActivate` is never called without the capability,
 * which is what keeps a locked toggle from starting a premium calculation.
 *
 * This is presentation only. The values behind the feature are withheld by the
 * server; nothing here is relied on as a boundary.
 */
export function LockedFeatureButton({
  capability,
  source,
  children,
  onActivate,
  pressed,
  className,
  lockedClassName,
  disabled = false,
  'aria-describedby': describedBy,
  'data-testid': testId,
}: LockedFeatureButtonProps) {
  const { can, requestUpgrade } = useEntitlement();
  const unlocked = can(capability);
  const tier = upgradeTargetTier(capability);
  const copy = upgradeCopy(capability);

  if (unlocked) {
    return (
      <button
        type="button"
        aria-pressed={pressed}
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={onActivate}
        data-testid={testId}
        className={className}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => requestUpgrade({ capability, source })}
      aria-describedby={describedBy}
      data-testid={testId}
      data-locked="true"
      data-capability={capability}
      data-required-tier={tier}
      title={`${copy.title} — ต้องใช้แพ็กเกจ ${PLAN_DISPLAY_NAME[tier]}`}
      aria-label={`${copy.title} — ต้องใช้แพ็กเกจ ${PLAN_DISPLAY_NAME[tier]}`}
      className={[className ?? '', 'inline-flex items-center gap-1', lockedClassName ?? ''].join(' ')}
    >
      <Lock aria-hidden="true" size={12} className="shrink-0" />
      {children}
    </button>
  );
}
