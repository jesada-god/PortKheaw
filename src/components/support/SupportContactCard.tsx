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
 *
 * Whether a channel is a link is now decided by whether it HAS a verified URL,
 * not by which channel it is — so adding one for Facebook to `SUPPORT_CONTACTS`
 * is the only edit that turns it into a link, and no URL is ever guessed here.
 */

const CARD_CLASS =
  'flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] p-3.5';
const ICON_CLASS =
  'flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]';
const LINK_CLASS =
  'transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:bg-[var(--surface-selected)]';

function ContactCard({
  icon,
  label,
  value,
  detail,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  href?: string;
}) {
  const body = (
    <>
      <span className={ICON_CLASS}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
        <p className="truncate font-medium text-[var(--text)]">{value}</p>
        <p className="truncate text-xs text-[var(--text-muted)]">{detail}</p>
      </div>
    </>
  );
  if (!href) return <div className={CARD_CLASS}>{body}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`เข้าร่วม ${label} ${value} (เปิดในแท็บใหม่)`}
      className={`${CARD_CLASS} ${LINK_CLASS}`}
    >
      {body}
    </a>
  );
}

export function SupportContactCard() {
  return (
    <section className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold text-[var(--text)]">ชุมชนและการช่วยเหลือ</h2>
        <p className="text-sm text-[var(--text-muted)]">
          เข้าร่วมชุมชน PortKheaw เพื่อสอบถามวิธีใช้งาน แจ้งปัญหา เสนอแนะฟีเจอร์ และติดตามประกาศล่าสุด
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ContactCard
          icon={<MessagesSquare aria-hidden="true" size={19} />}
          label={SUPPORT_CONTACTS.lineOpenChat.label}
          value={SUPPORT_CONTACTS.lineOpenChat.value}
          detail={SUPPORT_CONTACTS.lineOpenChat.detail}
          href={SUPPORT_CONTACTS.lineOpenChat.href}
        />
        <ContactCard
          icon={<Facebook aria-hidden="true" size={19} />}
          label={SUPPORT_CONTACTS.facebook.label}
          value={SUPPORT_CONTACTS.facebook.value}
          detail={SUPPORT_CONTACTS.facebook.detail}
          href={SUPPORT_CONTACTS.facebook.href}
        />
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        ทีมงานจะไม่ขอรหัสผ่าน รหัส OTP หรือข้อมูลบัตรเครดิตผ่านแชตทุกกรณี
      </p>
    </section>
  );
}
