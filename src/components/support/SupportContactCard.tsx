import { MessageCircle, Phone } from 'lucide-react';
import { SUPPORT_CONTACTS } from '@/src/lib/legal/documents';

/**
 * The two channels that work when the product does not.
 *
 * They are on the page above the ticket form, and they stay reachable to a
 * signed-out visitor, because the readers who most need help are the ones who
 * cannot sign in to file a ticket. A support system that is only reachable from
 * inside the account is not a support system for exactly the people it matters
 * most to.
 *
 * Rendered as copyable text rather than deep links: a `line://` URL fails
 * silently on desktop, and the Facebook name is a name to search rather than an
 * address we can guarantee resolves.
 */
export function SupportContactCard() {
  return (
    <section className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold text-[var(--text)]">ติดต่อทีมงานโดยตรง</h2>
        <p className="text-sm text-[var(--text-muted)]">
          ใช้ช่องทางนี้ได้เสมอ โดยเฉพาะเมื่อเข้าสู่ระบบไม่ได้ หรือมีเรื่องเร่งด่วนเกี่ยวกับการชำระเงิน
        </p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] p-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <MessageCircle aria-hidden="true" size={19} />
          </span>
          <div className="min-w-0">
            <dt className="text-xs text-[var(--text-muted)]">{SUPPORT_CONTACTS.facebook.label}</dt>
            <dd className="truncate font-medium text-[var(--text)]">
              {SUPPORT_CONTACTS.facebook.value}
            </dd>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] p-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Phone aria-hidden="true" size={19} />
          </span>
          <div className="min-w-0">
            <dt className="text-xs text-[var(--text-muted)]">{SUPPORT_CONTACTS.line.label}</dt>
            <dd className="truncate font-medium text-[var(--text)]">{SUPPORT_CONTACTS.line.value}</dd>
          </div>
        </div>
      </dl>

      <p className="text-xs text-[var(--text-muted)]">
        ทีมงานจะไม่ขอรหัสผ่าน รหัส OTP หรือเลขบัตรเครดิตของคุณผ่านช่องทางใดทั้งสิ้น
      </p>
    </section>
  );
}
