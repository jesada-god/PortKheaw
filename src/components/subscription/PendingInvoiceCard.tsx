import { AlertTriangle, CalendarClock, QrCode, Smartphone } from 'lucide-react';
import { AbandonInvoiceButton } from './AbandonInvoiceButton';
import type { PendingPromptPayView } from '@/src/lib/billing/promptpay-pending';
import { formatBangkokDateTime } from '@/src/lib/subscription/trial';

/**
 * The card for a purchase that has been started and not yet paid — the state
 * only the PromptPay rail has.
 *
 * Everything it says is chosen so that a reader can finish paying from wherever
 * they actually are. The QR lives on the provider's own invoice page rather than
 * being rendered here: that page regenerates the code when it expires, which a
 * screenshot of ours could not, and it means no payment artefact is stored by
 * this product at all. Payment is proven by the provider's signed confirmation
 * and by nothing else — there is deliberately no way to upload a slip here, and
 * no button that says "I have paid".
 *
 * The card is careful about one more thing: it never claims a plan is active.
 * Until the bank confirms, this is an invoice and nothing more.
 */

const TONE_CLASS: Readonly<Record<PendingPromptPayView['tone'], string>> = {
  awaiting: 'border-[var(--warning)] text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]',
  'due-soon': 'border-[var(--warning)] text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_18%,transparent)]',
  overdue: 'border-[var(--negative)] text-[var(--negative)] bg-[color-mix(in_srgb,var(--negative)_12%,transparent)]',
};

const TONE_LABEL: Readonly<Record<PendingPromptPayView['tone'], string>> = {
  awaiting: 'รอชำระเงิน',
  'due-soon': 'ใกล้หมดอายุ',
  overdue: 'เลยกำหนดชำระ',
};

export function PendingInvoiceCard({ view }: { view: PendingPromptPayView }) {
  return (
    <section
      aria-labelledby="pending-invoice-heading"
      data-testid="pending-invoice-card"
      data-tone={view.tone}
      className="min-w-0 space-y-4 rounded-3xl border border-[var(--warning)] bg-[var(--surface-elevated)] p-5 sm:p-7"
    >
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id="pending-invoice-heading" className="text-lg font-bold text-[var(--text)]">
            ใบแจ้งหนี้ PromptPay
          </h2>
          <span
            data-testid="pending-invoice-status"
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[view.tone]}`}
          >
            {TONE_LABEL[view.tone]}
          </span>
        </div>
        <p className="min-w-0 text-base font-semibold break-words text-[var(--text)]">
          {view.planName} · <span className="tabular-nums">{view.amountLabel}</span>
        </p>
        {/* Stated before anything else a reader might mistake for access. */}
        <p className="text-sm leading-6 text-[var(--text-secondary)]">
          แพ็กเกจจะเปิดใช้งานหลังจากธนาคารยืนยันการชำระเงินเท่านั้น การสร้างใบแจ้งหนี้ยังไม่เปิดสิทธิ์
        </p>
      </div>

      <dl className="min-w-0 space-y-3 border-t border-[var(--border)] pt-4 text-sm">
        {view.dueAt && (
          <div className="flex min-w-0 items-start gap-2">
            <CalendarClock aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
            <div className="min-w-0">
              <dt className="text-[var(--text-muted)]">ชำระภายใน</dt>
              <dd data-testid="pending-invoice-due" className="mt-0.5 font-medium break-words text-[var(--text)]">
                {formatBangkokDateTime(view.dueAt)}
              </dd>
            </div>
          </div>
        )}
      </dl>

      <p
        data-testid="pending-invoice-reminder"
        role={view.tone === 'overdue' ? 'alert' : undefined}
        className="flex items-start gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-hover)] px-3 py-2.5 text-sm leading-6 text-[var(--text)]"
      >
        <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--warning)]" />
        <span>{view.reminder}</span>
      </p>

      <div className="min-w-0 space-y-2 border-t border-[var(--border)] pt-4">
        {view.hostedInvoiceUrl && view.tone !== 'overdue' && (
          <a
            data-testid="pending-invoice-link"
            href={view.hostedInvoiceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={[
              'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold',
              'bg-[var(--accent)] text-[var(--accent-fg)] motion-safe:transition-colors',
              'hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
            ].join(' ')}
          >
            <QrCode aria-hidden="true" size={16} className="shrink-0" />
            เปิดใบแจ้งหนี้ และสแกน QR
          </a>
        )}

        {/* How to actually pay this from a phone, including the common case:
            the reader is on a laptop and the banking app is on the phone. */}
        <p className="flex items-start gap-2 text-xs leading-5 text-[var(--text-muted)]">
          <Smartphone aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
          <span>
            เปิดลิงก์นี้บนมือถือแล้วสแกนด้วย K PLUS หรือแอปธนาคารอื่นได้เลย
            {' '}หากเปิดบนคอมพิวเตอร์ ให้สแกน QR จากหน้าจอ หรือบันทึกภาพ QR
            {' '}แล้วเลือก “สแกนจากรูปภาพ” ในแอปธนาคาร
            {' '}ลิงก์นี้ใช้ได้กับใบแจ้งหนี้ใบนี้เท่านั้น อย่าส่งต่อให้ผู้อื่น
          </span>
        </p>

        <AbandonInvoiceButton />
      </div>
    </section>
  );
}
