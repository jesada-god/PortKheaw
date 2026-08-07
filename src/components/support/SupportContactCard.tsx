import { Facebook, MessagesSquare } from 'lucide-react';
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
 * The OpenChat card is a real link, because an https invite opens the room in
 * the app on a phone and a joinable web page on a desktop — the reason the old
 * `line://` deep link had to be rendered as copyable text instead. The invite
 * URL itself lives in `SUPPORT_CONTACTS` and is never printed on screen: it is
 * thirty unreadable characters of token, and a reader has nothing to do with it
 * but click. Facebook stays copyable text: a name to search for, not an address
 * we can guarantee resolves.
 */
export function SupportContactCard() {
  const cardClass =
    'flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] p-3.5';
  const iconClass =
    'flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]';

  return (
    <section className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold text-[var(--text)]">ชุมชนและการช่วยเหลือ</h2>
        <p className="text-sm text-[var(--text-muted)]">
          เข้าร่วมชุมชน PortKheaw เพื่อสอบถามวิธีใช้งาน แจ้งปัญหา เสนอแนะฟีเจอร์ และติดตามประกาศล่าสุด
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <a
          href={SUPPORT_CONTACTS.lineOpenChat.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`เข้าร่วม ${SUPPORT_CONTACTS.lineOpenChat.label} ${SUPPORT_CONTACTS.lineOpenChat.value} (เปิดในแท็บใหม่)`}
          className={`${cardClass} transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:bg-[var(--surface-selected)]`}
        >
          <span className={iconClass}>
            <MessagesSquare aria-hidden="true" size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-[var(--text-muted)]">
              {SUPPORT_CONTACTS.lineOpenChat.label}
            </p>
            <p className="truncate font-medium text-[var(--text)]">
              {SUPPORT_CONTACTS.lineOpenChat.value}
            </p>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {SUPPORT_CONTACTS.lineOpenChat.detail}
            </p>
          </div>
        </a>

        <div className={cardClass}>
          <span className={iconClass}>
            <Facebook aria-hidden="true" size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-[var(--text-muted)]">{SUPPORT_CONTACTS.facebook.label}</p>
            <p className="truncate font-medium text-[var(--text)]">
              {SUPPORT_CONTACTS.facebook.value}
            </p>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {SUPPORT_CONTACTS.facebook.detail}
            </p>
          </div>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        ทีมงานจะไม่ขอรหัสผ่าน รหัส OTP หรือข้อมูลบัตรเครดิตผ่านแชตทุกกรณี
      </p>
    </section>
  );
}
