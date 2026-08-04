import { notFound, redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { CancelRefundButton } from '@/src/components/refunds/CancelRefundButton';
import { ReplyForm } from '@/src/components/support/ReplyForm';
import { StatusChip } from '@/src/components/support/StatusChip';
import { ThreadView } from '@/src/components/support/ThreadView';
import { replyToRefundRequestAction } from '@/app/settings/refunds/actions';
import { createClient } from '@/src/lib/supabase/server';
import { readRefundRequest } from '@/src/lib/support/refund-repository';
import {
  REFUND_REASON_LABEL,
  REFUND_STATUS_EXPLANATION,
  REFUND_STATUS_LABEL,
  displayBaht,
  refundAcceptsReply,
  refundIsCancelable,
  refundStatusTone,
} from '@/src/lib/support/presentation';

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
 * One refund request, as its owner sees it.
 *
 * Internal notes are excluded from the query as well as hidden by the policy,
 * and the status explanation under the chip is doing real work: `approved` in
 * particular has to say both "we agreed" and "the money has not moved and your
 * plan still works", because readers reliably assume only the first.
 */
export default async function RefundDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  if (!supabase) notFound();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=/settings/refunds/${id}`);

  const request = await readRefundRequest(supabase, id);
  if (!request) notFound();

  const amount = displayBaht(request.amountMinor, request.currency);

  return (
    <div className="min-w-0">
      <Header
        title="คำขอคืนเงิน"
        subtitle={`หมายเลข ${request.reference}`}
        backFallbackHref="/settings/refunds"
      />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={REFUND_STATUS_LABEL[request.status]}
              tone={refundStatusTone(request.status)}
            />
            <span className="text-xs text-[var(--text-muted)]">
              {REFUND_REASON_LABEL[request.reasonCategory]} · ส่งเมื่อ {when(request.createdAt)}
            </span>
          </div>

          <p className="text-sm leading-7 text-[var(--text)]">
            {REFUND_STATUS_EXPLANATION[request.status]}
          </p>

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

          {refundIsCancelable(request.status) && <CancelRefundButton requestId={request.id} />}
        </section>

        <ThreadView
          opening={{ body: request.details, createdAt: request.createdAt }}
          messages={request.messages}
          attachments={request.attachments}
        />

        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">ตอบกลับ</h2>
          <ReplyForm
            action={replyToRefundRequestAction}
            idField="requestId"
            idValue={request.id}
            disabledReason={
              refundAcceptsReply(request.status)
                ? undefined
                : 'คำขอนี้ปิดแล้ว หากยังมีข้อสงสัย ติดต่อทีมงานผ่านหน้าช่วยเหลือได้'
            }
          />
        </section>
      </main>
    </div>
  );
}
