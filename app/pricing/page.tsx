import type { Metadata } from 'next';
import Link from 'next/link';
import Header from '@/src/components/layout/Header';
import { LegalFooterLinks } from '@/src/components/legal/LegalFooterLinks';
import { PlanComparison } from '@/src/components/subscription/PlanComparison';
import { PublicPlanCards } from '@/src/components/subscription/PublicPlanCards';
import { SubscriptionFaq } from '@/src/components/subscription/SubscriptionFaq';
import { getBillingAvailability } from '@/src/lib/billing/billing-server';
import { createClient } from '@/src/lib/supabase/server';
import { TRIAL_ELIGIBILITY_STATEMENT } from '@/src/lib/subscription/trial';

/**
 * Prices, in public.
 *
 * Deliberately **not** a protected route, for the same reason `/support` is not:
 * somebody deciding whether this product is worth an account should be able to
 * see what it costs before creating one. Everything on the page is derived —
 * `planDescriptors` for the cards, `planFeatureGroups` (whose enforced rows come
 * straight out of the entitlement matrix) for the comparison, and the billing
 * catalogue for every amount — so nothing here can quote a price or promise a
 * feature that the signed-in page and the checkout would contradict.
 *
 * It starts no purchase. Both call to actions link into the existing sign-up and
 * subscription flows, so `PurchaseConsentDialog` and the checkout action remain
 * the only path to a payment.
 *
 * Per-reader (the CTA depends on whether there is a session), so never
 * prerendered into shared HTML.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'แพ็กเกจและราคา',
  description: 'เปรียบเทียบแพ็กเกจ Basic, Pro และ Elite ของ PortKheaw ราคารายเดือนและรายปี',
};

export default async function PricingPage() {
  const supabase = await createClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const authenticated = Boolean(data?.user);
  /*
   * Availability is resolved for an anonymous viewer on purpose: this page must
   * never imply a purchase is open to somebody it is not open to. It carries
   * booleans and plan keys only — never a price identifier, never a reason.
   */
  const availability = getBillingAvailability();

  return (
    <div className="min-w-0">
      <Header title="แพ็กเกจและราคา" subtitle="เลือกแพ็กเกจที่เหมาะกับพอร์ตของคุณ" />
      <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-8 p-4 md:p-8">
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
          <h2 className="text-base font-semibold text-[var(--text)]">
            เริ่มต้นฟรี อัปเกรดเมื่อพอร์ตของคุณต้องการมากขึ้น
          </h2>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            แพ็กเกจ Basic ใช้งานได้ฟรีตลอดชีพ ไม่ต้องผูกบัตร
            และบัญชีที่ยืนยันอีเมลแล้วเริ่มทดลอง Elite ได้โดยไม่มีค่าใช้จ่าย
          </p>
          <p className="text-sm leading-6 text-[var(--text-muted)]">{TRIAL_ELIGIBILITY_STATEMENT}</p>
          {!authenticated && (
            <Link
              href="/auth/sign-up?next=/settings/subscription"
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-fg)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              สมัครฟรี
            </Link>
          )}
        </section>

        <PublicPlanCards availability={availability} authenticated={authenticated} />
        <PlanComparison />
        <SubscriptionFaq billingEnabled={availability.enabled} />

        <p className="text-xs leading-6 text-[var(--text-muted)]">
          ราคาทั้งหมดเป็นเงินบาทและรวมภาษีตามที่ระบุในหน้าชำระเงิน
          รายละเอียดรอบบิล การต่ออายุ และเงื่อนไข Founder&rsquo;s Club อยู่ใน{' '}
          <Link href="/subscription-policy" className="underline underline-offset-4 hover:text-[var(--text)]">
            นโยบายแพ็กเกจและการชำระเงิน
          </Link>
          {' '}และการขอคืนเงินอยู่ใน{' '}
          <Link href="/refund-policy" className="underline underline-offset-4 hover:text-[var(--text)]">
            นโยบายการคืนเงิน
          </Link>
        </p>

        <LegalFooterLinks />
      </main>
    </div>
  );
}
