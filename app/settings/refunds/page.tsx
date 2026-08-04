import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import Link from 'next/link';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { RefundRequestForm } from '@/src/components/refunds/RefundRequestForm';
import { RefundRequestList } from '@/src/components/refunds/RefundRequestList';
import { createClient } from '@/src/lib/supabase/server';
import { listMyBillingInvoices, listMyRefundRequests } from '@/src/lib/support/refund-repository';

/** Per-reader billing state; never prerendered into shared HTML. */
export const dynamic = 'force-dynamic';

export default async function RefundsPage() {
  const supabase = await createClient();
  if (!supabase) {
    return (
      <>
        <Header title="คำขอคืนเงิน" />
        <div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div>
      </>
    );
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/settings/refunds');

  const [invoices, requests] = await Promise.all([
    listMyBillingInvoices(supabase),
    listMyRefundRequests(supabase),
  ]);

  return (
    <div className="min-w-0">
      <Header
        title="คำขอคืนเงิน"
        subtitle="ส่งคำขอ ติดตามสถานะ และดูผลการพิจารณา"
        backFallbackHref="/settings/subscription"
      />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-8 p-4 md:p-8">
        <section className="min-w-0 space-y-4">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-[var(--text)]">ส่งคำขอใหม่</h2>
            <p className="text-sm text-[var(--text-muted)]">
              เลือกรายการชำระเงินที่ต้องการขอคืน เงื่อนไขทั้งหมดอยู่ที่{' '}
              <Link
                href="/refund-policy"
                className="font-medium text-[var(--accent)] underline underline-offset-4 hover:text-[var(--accent-hover)]"
              >
                นโยบายการคืนเงิน
              </Link>
            </p>
          </div>
          <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
            <RefundRequestForm invoices={invoices} />
          </div>
        </section>

        <section className="min-w-0 space-y-3">
          <h2 className="text-base font-semibold text-[var(--text)]">คำขอของคุณ</h2>
          <RefundRequestList
            requests={requests}
            hrefBase="/settings/refunds"
            emptyMessage="ยังไม่มีคำขอคืนเงิน เมื่อส่งคำขอแล้วจะแสดงที่นี่พร้อมสถานะล่าสุด"
          />
        </section>
      </main>
    </div>
  );
}
