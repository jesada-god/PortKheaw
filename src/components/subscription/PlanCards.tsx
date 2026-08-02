import { Check, Clock } from 'lucide-react';
import {
  featureSummary,
  formatBaht,
  planDescriptors,
  planFeatureRow,
  type PlanDescriptor,
} from '@/src/lib/subscription/plan-catalog';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

/**
 * The three plans as sold. Prices and feature lines both come from the central
 * plan catalog, so a card can never claim something the comparison table below
 * it contradicts.
 *
 * Neither paid plan can be bought yet, so both carry an inert "เร็ว ๆ นี้"
 * marker rather than a button. There is deliberately no checkout affordance of
 * any kind here — not a disabled one, and not a link that pretends to lead
 * somewhere.
 */
export function PlanCards({ effectiveTier }: { effectiveTier: SubscriptionTier }) {
  return (
    <section aria-labelledby="plans-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="plans-heading" className="text-xl font-bold text-[var(--text)]">แพ็กเกจทั้งหมด</h2>
        <p className="text-sm text-[var(--text-muted)]">
          เลือกได้เมื่อระบบชำระเงินเปิดใช้งาน ตอนนี้ทดลอง Elite ได้ฟรีก่อน
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {planDescriptors.map((plan) => (
          <PlanCard key={plan.tier} plan={plan} current={plan.tier === effectiveTier} />
        ))}
      </div>
    </section>
  );
}

function PlanCard({ plan, current }: { plan: PlanDescriptor; current: boolean }) {
  const recommended = Boolean(plan.badge);
  return (
    <article
      className={[
        'flex h-full min-w-0 flex-col gap-5 rounded-2xl border bg-[var(--surface)] p-5 shadow-[var(--shadow)]',
        recommended
          ? 'border-[var(--accent)]'
          : 'border-[var(--border)]',
      ].join(' ')}
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-bold text-[var(--text)]">{plan.name}</h3>
          {plan.badge && (
            <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-fg)]">
              {plan.badge}
            </span>
          )}
          {current && (
            <span className="rounded-full border border-[var(--border-strong)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
              แพ็กเกจปัจจุบัน
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--text-secondary)]">{plan.tagline}</p>
      </header>

      <PlanPrice plan={plan} />

      <ul className="flex flex-1 flex-col gap-2.5 text-sm text-[var(--text-secondary)]">
        {plan.highlights.map((id) => (
          <li key={id} className="flex items-start gap-2">
            <Check
              aria-hidden="true"
              size={16}
              className="mt-0.5 shrink-0 text-[var(--brand-green)]"
            />
            <span className="min-w-0">{featureSummary(planFeatureRow(id), plan.tier)}</span>
          </li>
        ))}
      </ul>

      {plan.pricing && (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] px-3 py-2.5 text-sm font-medium text-[var(--text-muted)]">
          <Clock aria-hidden="true" size={15} className="shrink-0" />
          เปิดให้สมัคร เร็ว ๆ นี้
        </p>
      )}
    </article>
  );
}

function PlanPrice({ plan }: { plan: PlanDescriptor }) {
  if (!plan.pricing) {
    return (
      <p className="text-2xl font-bold tabular-nums text-[var(--text)]">
        {plan.freeLabel}
      </p>
    );
  }
  const { monthlyBaht, yearlyBaht, founderFirstYearBaht } = plan.pricing;
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[var(--text)]">
        <span className="text-3xl font-bold tabular-nums">{formatBaht(monthlyBaht)}</span>
        <span className="text-sm text-[var(--text-muted)]">บาท/เดือน</span>
      </p>
      <p className="text-sm tabular-nums text-[var(--text-secondary)]">
        หรือ {formatBaht(yearlyBaht)} บาท/ปี
      </p>
      <div className="rounded-xl border border-[var(--brand-green)] bg-[color-mix(in_srgb,var(--brand-green)_10%,transparent)] px-3 py-2">
        <p className="text-sm font-semibold tabular-nums text-[var(--brand-green)]">
          Founder&rsquo;s Club ปีแรก {formatBaht(founderFirstYearBaht)} บาท
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          ราคานี้จะใช้ได้เมื่อระบบชำระเงินจริงเปิดใช้งาน
        </p>
      </div>
    </div>
  );
}
