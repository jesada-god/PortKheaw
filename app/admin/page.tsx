import Link from 'next/link';
import { ChevronRight, LifeBuoy, ReceiptText, Wallet } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { createClient } from '@/src/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * The operator hub.
 *
 * Three destinations and three counts. The counts are the point: an operator
 * opening this page needs to know whether anything is waiting, and a hub that
 * only lists links makes them visit all three to find out.
 *
 * Counts are read through the operator's own session, so the same row-level
 * policies that protect the lists protect these numbers.
 */
const DESTINATIONS = [
  {
    href: '/admin/billing',
    icon: Wallet,
    title: 'ปฏิบัติการบิลลิ่ง',
    description: 'ค้นหาบัญชี ดูสิทธิ์ ใบแจ้งหนี้ ประวัติ webhook และรายการที่ต้องตรวจสอบ',
  },
  {
    href: '/admin/support',
    icon: LifeBuoy,
    title: 'เรื่องที่ผู้ใช้แจ้ง',
    description: 'ตอบกลับ เปลี่ยนสถานะ และบันทึกภายใน',
  },
  {
    href: '/admin/refunds',
    icon: ReceiptText,
    title: 'คำขอคืนเงิน',
    description: 'ตรวจสอบคำขอ บันทึกภายใน และบันทึกผลการคืนเงิน',
  },
] as const;

export default async function AdminHubPage() {
  const supabase = await createClient();

  let openTickets = 0;
  let openRefunds = 0;
  let openIssues = 0;
  if (supabase) {
    try {
      const [tickets, refunds, issues] = await Promise.all([
        supabase
          .from('support_tickets')
          .select('id', { count: 'exact', head: true })
          .in('status', ['open', 'in_progress']),
        supabase
          .from('refund_requests')
          .select('id', { count: 'exact', head: true })
          .in('status', ['pending', 'reviewing', 'approved']),
        supabase.rpc('admin_open_billing_issues', { input_user_id: null, input_limit: 200 }),
      ]);
      openTickets = tickets.count ?? 0;
      openRefunds = refunds.count ?? 0;
      openIssues = issues.data?.length ?? 0;
    } catch {
      // A count that could not be read shows as zero rather than failing the
      // hub. The lists themselves are the source of truth.
    }
  }

  const counts: Readonly<Record<string, number>> = {
    '/admin/billing': openIssues,
    '/admin/support': openTickets,
    '/admin/refunds': openRefunds,
  };

  return (
    <div className="min-w-0">
      <Header title="ศูนย์ปฏิบัติการ" subtitle="เฉพาะผู้ดูแลระบบ" backFallbackHref="/" />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 p-4 md:p-8">
        <p className="text-sm text-[var(--text-muted)]">
          หน้านี้แสดงข้อมูลที่จำเป็นต่อการดูแลระบบเท่านั้น ไม่มีเลขบัตร ไม่มีรหัสลับ
          และไม่มีตัวระบุของผู้ให้บริการชำระเงิน
        </p>

        <ul className="min-w-0 space-y-2">
          {DESTINATIONS.map((destination) => {
            const Icon = destination.icon;
            const count = counts[destination.href] ?? 0;
            return (
              <li key={destination.href} className="min-w-0">
                <Link
                  href={destination.href}
                  className="flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Icon aria-hidden="true" size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-[var(--text)]">{destination.title}</span>
                    <span className="block text-xs text-[var(--text-muted)]">{destination.description}</span>
                  </span>
                  {count > 0 && (
                    <span className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-medium tabular-nums text-[var(--accent-fg)]">
                      {count}
                    </span>
                  )}
                  <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
