import Link from 'next/link';
import { notFound } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { RefundDecisionControl } from '@/src/components/admin/RefundDecisionControl';
import { ReplyForm } from '@/src/components/support/ReplyForm';
import { StatusChip } from '@/src/components/support/StatusChip';
import { ThreadView } from '@/src/components/support/ThreadView';
import { adminReplyToRefundRequestAction } from '@/app/settings/refunds/actions';
import { createClient } from '@/src/lib/supabase/server';
import { readRefundAudit, readRefundRequest } from '@/src/lib/support/refund-repository';
import {
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
  displayBaht,
  refundStatusTone,
} from '@/src/lib/support/presentation';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';

export const dynamic = 'force-dynamic';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/**
 * Reviewing one refund request.
 *
 * The billing context an operator needs — which purchase, how much, what plan —
 * is reached through the sanitized account search, linked rather than embedded,
 * so this page never becomes a second projection of somebody's billing record
 * that has to be kept sanitized separately.
 */
export default async function AdminRefundDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // The gate, before anything is read. See `admin-guard.ts`: a layout cannot
  // stop this page from rendering, so the page stops itself.
  await requireAdminPage();
  const { id } = await params;
  const supabase = await createClient();
  if (!supabase) notFound();

  const request = await readRefundRequest(supabase, id, { includeInternal: true });
  if (!request) notFound();
  const audit = await readRefundAudit(supabase, id);

  const amount = displayBaht(request.amountMinor, request.currency);

  return (
    <div className="min-w-0">
      <Header
        title="คำขอคืนเงิน"
        subtitle={`${request.reference} · ${REFUND_REASON_LABEL[request.reasonCategory]}`}
        backFallbackHref="/admin/refunds"
      />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={REFUND_STATUS_LABEL[request.status]}
              tone={refundStatusTone(request.status)}
            />
            <span className="text-xs text-[var(--text-muted)]">
              แพ็กเกจตอนยื่น: {request.tierSnapshot} · ส่งเมื่อ {when(request.createdAt)}
            </span>
          </div>

          <dl className="grid gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-[var(--text-muted)]">ยอดที่ขอคืน</dt>
              <dd className="font-medium tabular-nums text-[var(--text)]">
                {amount ? `${amount} บาท` : '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-[var(--text-muted)]">คืนเงินเมื่อ</dt>
              <dd className="font-medium text-[var(--text)]">{when(request.refundedAt)}</dd>
            </div>
          </dl>

          <Link
            href={`/admin/billing?q=${encodeURIComponent(request.userId)}`}
            className="inline-flex min-h-9 items-center text-sm font-medium text-[var(--accent)] underline underline-offset-4 hover:text-[var(--accent-hover)]"
          >
            เปิดประวัติบิลลิ่งของบัญชีนี้
          </Link>
        </section>

        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">การตัดสิน</h2>
          <RefundDecisionControl requestId={request.id} current={request.status} />
        </section>

        <ThreadView
          opening={{ body: request.details, createdAt: request.createdAt }}
          messages={request.messages}
          attachments={request.attachments}
          ownLabel="ผู้ใช้"
        />

        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">ตอบกลับหรือบันทึกภายใน</h2>
          <ReplyForm
            action={adminReplyToRefundRequestAction}
            idField="requestId"
            idValue={request.id}
            placeholder="ข้อความถึงผู้ใช้ หรือบันทึกภายในสำหรับทีมงาน"
            submitLabel="บันทึกข้อความ"
            internalToggle
          />
        </section>

        <section className="min-w-0 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">บันทึกการตรวจสอบ</h2>
          <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{entry.action}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  {entry.actorRole}
                  {entry.fromStatus || entry.toStatus
                    ? ` · ${entry.fromStatus ?? '—'} → ${entry.toStatus ?? '—'}`
                    : ''}
                </span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{when(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
