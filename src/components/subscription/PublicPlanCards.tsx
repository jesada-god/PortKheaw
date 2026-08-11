import Link from 'next/link';
import { Check } from 'lucide-react';
import {
  featureSummary,
  planDescriptors,
  planFeatureRow,
  type PlanDescriptor,
} from '@/src/lib/subscription/plan-catalog';
import type { BillingAvailability } from '@/src/lib/billing/billing-config';
import { PlanPriceBlock } from './PlanCards';

/**
 * The plans as a visitor sees them before signing in.
 *
 * Everything a reader compares — names, taglines, prices, Founder's first-year
 * amount and the feature lines — comes from the same `planDescriptors` and
 * `planFeatureGroups` the signed-in page renders, which read their prices from
 * the billing rows the checkout actually charges against. Nothing here is a
 * second copy of a price or a feature list.
 *
 * The one deliberate difference is the call to action. This page starts NO
 * purchase: it links into the existing sign-up / subscription flow, so the
 * purchase-consent dialog, the entitlement matrix and the checkout action stay
 * the only things that can begin one.
 */
export function PublicPlanCards({
  availability,
  authenticated,
}: {
  availability: BillingAvailability;
  authenticated: boolean;
}) {
  return (
    <section aria-labelledby="public-plans-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="public-plans-heading" className="text-xl font-bold text-[var(--text)]">
          แพ็กเกจทั้งหมด
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          {availability.enabled
            ? 'เลือกแพ็กเกจที่เหมาะกับพอร์ตของคุณ ยกเลิกได้ทุกเมื่อ'
            : 'ระบบชำระเงินยังไม่เปิดในตอนนี้ ดูรายละเอียดแต่ละแพ็กเกจไว้ก่อนได้'}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {planDescriptors.map((plan) => (
          <PublicPlanCard
            key={plan.tier}
            plan={plan}
            billingOpen={availability.enabled}
            authenticated={authenticated}
          />
        ))}
      </div>
    </section>
  );
}

function PublicPlanCard({ plan, billingOpen, authenticated }: {
  plan: PlanDescriptor;
  billingOpen: boolean;
  authenticated: boolean;
}) {
  const recommended = Boolean(plan.badge);
  /*
   * A signed-in reader continues on the subscription page, which is where the
   * purchase-consent dialog and the checkout action live. A visitor is sent to
   * sign-up carrying that same destination, so the flow after they have an
   * account is byte-for-byte the one they would have followed anyway.
   */
  const href = authenticated
    ? '/settings/subscription'
    : '/auth/sign-up?next=/settings/subscription';
  const label = plan.pricing
    ? authenticated ? `เลือก ${plan.name}` : `สมัครเพื่อเริ่มใช้ ${plan.name}`
    : authenticated ? 'ไปที่หน้าแพ็กเกจ' : 'เริ่มใช้ฟรี';

  return (
    <article
      data-plan={plan.tier}
      className={[
        'flex h-full min-w-0 flex-col gap-5 rounded-2xl border bg-[var(--surface)] p-5 shadow-[var(--shadow)]',
        recommended ? 'border-[var(--accent)]' : 'border-[var(--border)]',
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
        </div>
        <p className="text-sm text-[var(--text-secondary)]">{plan.tagline}</p>
      </header>

      <PlanPriceBlock plan={plan} billingOpen={billingOpen} />

      <ul className="flex flex-1 flex-col gap-2.5 text-sm text-[var(--text-secondary)]">
        {plan.highlights.map((id) => (
          <li key={id} className="flex items-start gap-2">
            <Check aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--brand-green)]" />
            <span className="min-w-0">{featureSummary(planFeatureRow(id), plan.tier)}</span>
          </li>
        ))}
      </ul>

      <Link
        href={href}
        className={[
          'inline-flex min-h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold transition-colors',
          recommended
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90'
            : 'border border-[var(--border-strong)] text-[var(--text)] hover:bg-[var(--surface-hover)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
        ].join(' ')}
      >
        {label}
      </Link>
    </article>
  );
}
