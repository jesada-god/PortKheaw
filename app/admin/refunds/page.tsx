import { Search } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { RefundRequestList } from '@/src/components/refunds/RefundRequestList';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { createClient } from '@/src/lib/supabase/server';
import { listRefundRequestsForAdmin } from '@/src/lib/support/refund-repository';
import { REFUND_STATUS_LABEL } from '@/src/lib/support/presentation';
import type { RefundRequestStatus } from '@/src/types/database';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';

export const dynamic = 'force-dynamic';

const STATUSES = Object.keys(REFUND_STATUS_LABEL) as RefundRequestStatus[];

export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The gate, before anything is read. See `admin-guard.ts`: a layout cannot
  // stop this page from rendering, so the page stops itself.
  await requireAdminPage();
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q : '';
  const status = typeof params.status === 'string' && STATUSES.includes(params.status as RefundRequestStatus)
    ? params.status as RefundRequestStatus
    : null;

  const supabase = await createClient();
  let requests: Awaited<ReturnType<typeof listRefundRequestsForAdmin>> = [];
  if (supabase) {
    try {
      requests = await listRefundRequestsForAdmin(supabase, { query, status });
    } catch {
      requests = [];
    }
  }

  return (
    <div className="min-w-0">
      <Header title="คำขอคืนเงิน" subtitle="ตรวจสอบและบันทึกผล" backFallbackHref="/admin" />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 p-4 md:p-8">
        <form method="get" className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <Input
            name="q"
            defaultValue={query}
            placeholder="ค้นหาด้วยหมายเลขคำขอ"
            aria-label="ค้นหาคำขอคืนเงิน"
            className="min-w-0 flex-1"
          />
          <div className="w-full sm:w-44">
            <Select name="status" defaultValue={status ?? ''} aria-label="กรองตามสถานะ">
              <option value="">ทุกสถานะ</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>{REFUND_STATUS_LABEL[value]}</option>
              ))}
            </Select>
          </div>
          <Button type="submit" className="shrink-0">
            <Search aria-hidden="true" size={16} className="mr-2" />
            ค้นหา
          </Button>
        </form>

        <RefundRequestList
          requests={requests}
          hrefBase="/admin/refunds"
          emptyMessage="ไม่มีคำขอที่ตรงกับเงื่อนไขนี้"
        />
      </main>
    </div>
  );
}
