import { Search } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { TicketList } from '@/src/components/support/TicketList';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { createClient } from '@/src/lib/supabase/server';
import { listTicketsForAdmin } from '@/src/lib/support/ticket-repository';
import { TICKET_STATUS_LABEL } from '@/src/lib/support/presentation';
import type { SupportTicketStatus } from '@/src/types/database';

export const dynamic = 'force-dynamic';

const STATUSES = Object.keys(TICKET_STATUS_LABEL) as SupportTicketStatus[];

/**
 * The ticket queue.
 *
 * Reads through the operator's own session, so the admin arm of the
 * `support_tickets` policy is what admits it. A non-operator running the exact
 * same query would see only their own tickets — which is the failure mode worth
 * having if a guard is ever missed upstream.
 */
export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q : '';
  const status = typeof params.status === 'string' && STATUSES.includes(params.status as SupportTicketStatus)
    ? params.status as SupportTicketStatus
    : null;

  const supabase = await createClient();
  let tickets: Awaited<ReturnType<typeof listTicketsForAdmin>> = [];
  if (supabase) {
    try {
      tickets = await listTicketsForAdmin(supabase, { query, status });
    } catch {
      tickets = [];
    }
  }

  return (
    <div className="min-w-0">
      <Header title="เรื่องที่ผู้ใช้แจ้ง" subtitle="ค้นหา ตอบกลับ และเปลี่ยนสถานะ" backFallbackHref="/admin" />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 p-4 md:p-8">
        <form method="get" className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <Input
            name="q"
            defaultValue={query}
            placeholder="ค้นหาด้วยหมายเลขเรื่องหรือหัวข้อ"
            aria-label="ค้นหาเรื่อง"
            className="min-w-0 flex-1"
          />
          <div className="w-full sm:w-44">
            <Select name="status" defaultValue={status ?? ''} aria-label="กรองตามสถานะ">
              <option value="">ทุกสถานะ</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>{TICKET_STATUS_LABEL[value]}</option>
              ))}
            </Select>
          </div>
          <Button type="submit" className="shrink-0">
            <Search aria-hidden="true" size={16} className="mr-2" />
            ค้นหา
          </Button>
        </form>

        <TicketList
          tickets={tickets}
          hrefBase="/admin/support"
          emptyMessage="ไม่มีเรื่องที่ตรงกับเงื่อนไขนี้"
        />
      </main>
    </div>
  );
}
