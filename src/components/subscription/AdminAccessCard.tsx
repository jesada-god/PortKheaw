import { ShieldCheck } from 'lucide-react';
import { resolveAccountBadges } from '@/src/lib/subscription/account-badges';
import type { RequestAccountAccess } from '@/src/lib/subscription/account-access';
import { AccountIdentity } from './AccountBadges';
import { AdminPreviewSelector } from './AdminPreviewSelector';

/**
 * What an administrator's access actually is, said plainly beside the plan they
 * actually hold.
 *
 * The distinction this card exists to make: an administrator opens every feature
 * because of their *role*, not because anything was purchased. The Current Plan
 * hero above it keeps describing the real subscription and is never rewritten by
 * a preview — so the page can be read top to bottom without confusing operator
 * access for a paid Elite plan.
 */
export function AdminAccessCard({ access, name }: { access: RequestAccountAccess; name: string }) {
  const badges = resolveAccountBadges({
    role: access.role,
    adminPreviewMode: access.adminPreviewMode,
    subscriptionEffectiveTier: access.subscriptionEffectiveTier,
    status: access.status,
  });

  return (
    <section
      aria-labelledby="admin-access-heading"
      data-testid="admin-access-card"
      className="min-w-0 space-y-4 rounded-3xl border border-[color-mix(in_srgb,var(--role-admin)_40%,transparent)] bg-[var(--surface-elevated)] p-5 sm:p-7"
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-[var(--role-admin)]" />
        <div className="min-w-0 space-y-2">
          <h2 id="admin-access-heading" className="text-lg font-bold text-[var(--text)]">
            สิทธิ์ผู้ดูแลระบบ PortKheaw
          </h2>
          <AccountIdentity
            name={name}
            badges={badges}
            nameClassName="text-sm font-semibold text-[var(--text-secondary)]"
          />
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            บัญชีนี้เปิดใช้ฟีเจอร์ได้ระดับ Elite จากสิทธิ์ผู้ดูแลระบบ
            {' '}<strong className="font-semibold text-[var(--text)]">ไม่ใช่แพ็กเกจ Elite แบบชำระเงิน</strong>
            {' '}สถานะแพ็กเกจและการเรียกเก็บเงินจริงแสดงอยู่ในการ์ด “แพ็กเกจปัจจุบัน” ด้านบน
          </p>
        </div>
      </div>

      <AdminPreviewSelector currentMode={access.adminPreviewMode} expiresAt={access.previewExpiresAt} />
    </section>
  );
}
