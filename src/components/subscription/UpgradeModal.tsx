'use client';

import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { recordPaywallEvent } from '@/src/lib/subscription/paywall-telemetry';
import { formatBaht, planDescriptor } from '@/src/lib/subscription/plan-catalog';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { PLAN_DISPLAY_NAME, upgradeCopy, upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import type { TrialOffer } from './EntitlementProvider';

export const SUBSCRIPTION_CENTRE_PATH = '/settings/subscription';

export interface UpgradeModalProps {
  /** `null` keeps the dialog unmounted — there is no hidden premium markup. */
  request: { capability: SubscriptionCapability; source: string } | null;
  currentTier: SubscriptionTier;
  trialOffer: TrialOffer;
  onClose(): void;
}

/**
 * The one upgrade prompt.
 *
 * It says three things and no more: which feature is locked, what the reader
 * gets when it is not, and which plan carries it. The plan name and price come
 * from the same catalog the subscription centre renders, and the plan itself is
 * derived from the entitlement matrix — so a prompt can never advertise a tier
 * that would not actually unlock the feature.
 *
 * Neither paid plan can be bought yet, so the only action is a link to the
 * subscription centre. There is no checkout here, real or simulated.
 */
export function UpgradeModal({ request, currentTier, trialOffer, onClose }: UpgradeModalProps) {
  if (!request) return null;

  const { capability, source } = request;
  const requiredTier = upgradeTargetTier(capability);
  const copy = upgradeCopy(capability);
  const descriptor = planDescriptor(requiredTier);
  const trialUnlocksIt = trialOffer === 'available' && requiredTier !== 'basic';

  const onCta = () => {
    recordPaywallEvent({
      event: 'upgrade_clicked',
      capability,
      source,
      requiredTier,
      currentTier,
    });
    onClose();
  };

  return (
    <ResponsiveDialog isOpen onClose={onClose} title={copy.title}>
      <div className="space-y-4 text-sm text-[var(--text-secondary)]" data-testid="upgrade-modal">
        <p
          data-testid="upgrade-required-plan"
          className="inline-flex items-center gap-2 rounded-full border border-[var(--brand-green)] bg-[color-mix(in_srgb,var(--brand-green)_12%,transparent)] px-3 py-1 text-xs font-semibold text-[var(--brand-green)]"
        >
          <Lock aria-hidden="true" size={13} />
          ต้องใช้แพ็กเกจ {PLAN_DISPLAY_NAME[requiredTier]}
        </p>

        <p className="leading-6 text-[var(--text)]">{copy.benefit}</p>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
          <p className="text-sm font-semibold text-[var(--text)]">
            {descriptor.name} · {descriptor.pricing
              ? `${formatBaht(descriptor.pricing.monthlyBaht)} บาท/เดือน`
              : descriptor.freeLabel ?? '—'}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{descriptor.tagline}</p>
          <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]" data-testid="upgrade-billing-note">
            ตอนนี้ยังซื้อแพ็กเกจแบบชำระเงินไม่ได้ · เปิดให้ซื้อเร็ว ๆ นี้
          </p>
        </div>

        {trialUnlocksIt && (
          <p className="flex items-start gap-2 rounded-xl border border-[var(--border)] p-3 text-xs leading-5 text-[var(--text-secondary)]">
            <Sparkles aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--brand-green)]" />
            <span>บัญชีนี้ยังไม่เคยใช้สิทธิ์ทดลอง Elite ฟรี 7 วัน เริ่มทดลองได้ที่หน้าแพ็กเกจ แล้วใช้ฟีเจอร์นี้ได้ทันที</span>
          </p>
        )}

        <Link
          href={SUBSCRIPTION_CENTRE_PATH}
          onClick={onCta}
          data-testid="upgrade-cta"
          className="flex min-h-11 w-full items-center justify-center rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-fg)] motion-safe:transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {trialUnlocksIt ? 'ไปเริ่มทดลอง Elite ฟรี 7 วัน' : 'ดูแพ็กเกจทั้งหมด'}
        </Link>
      </div>
    </ResponsiveDialog>
  );
}
