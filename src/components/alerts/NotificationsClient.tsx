'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { AlertTriangle, Bell, CalendarClock, CheckCheck, TrendingUp } from 'lucide-react';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/notifications/actions';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useToast } from '@/src/components/ui/Toast';
import type { AppNotification } from '@/src/lib/alerts/types';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import { useStore } from '@/src/store/useStore';

const PAGE_SIZE = 10;

const displayTime = (value: string) => new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
}).format(new Date(value));

function NotificationIcon({ type }: { type: AppNotification['type'] }) {
  if (type === 'daily_summary') return <CalendarClock className="mt-0.5 shrink-0 text-[var(--info)]" size={20} />;
  if (type === 'price_alert') return <TrendingUp className="mt-0.5 shrink-0 text-[var(--accent)]" size={20} />;
  if (type === 'quiet_hours_digest') return <Bell className="mt-0.5 shrink-0 text-[var(--text-secondary)]" size={20} />;
  return <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={20} />;
}

function maskedMessage(item: AppNotification, privacyMode: boolean): string {
  if (!privacyMode || item.type !== 'daily_summary') return item.message;
  const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
    ? item.metadata
    : null;
  if (!metadata || metadata.status !== 'ready') return item.message;
  const top = metadata.topContributor
    && typeof metadata.topContributor === 'object'
    && !Array.isArray(metadata.topContributor)
    ? metadata.topContributor
    : null;
  const parts = [
    `มูลค่าพอร์ตรวม ${SENSITIVE_VALUE_MASK}`,
    `วันนี้ ${SENSITIVE_VALUE_MASK} (${SENSITIVE_VALUE_MASK})`,
    top && typeof top.symbol === 'string'
      ? `ส่งผลมากที่สุด ${top.symbol} ${SENSITIVE_VALUE_MASK}`
      : 'วันนี้ยังไม่มีสินทรัพย์ที่เปลี่ยนแปลง',
  ];
  if (typeof metadata.valuedAt === 'string') {
    try {
      parts.push(`ข้อมูลล่าสุด ${new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: typeof metadata.timezone === 'string' ? metadata.timezone : 'Asia/Bangkok',
      }).format(new Date(metadata.valuedAt))}`);
    } catch {
      // An invalid legacy timezone must not make the inbox unusable.
    }
  }
  return parts.join(' · ');
}

export function NotificationsClient({ initialNotifications }: { initialNotifications: AppNotification[] }) {
  const [items, setItems] = useState(initialNotifications);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pending, startTransition] = useTransition();
  const { addToast } = useToast();
  const privacyMode = useStore((state) => state.privacyMode);
  const unread = items.filter((item) => !item.readAt).length;
  const visibleItems = items.slice(0, visibleCount);

  function notifyHeader() {
    window.dispatchEvent(new Event('notifications-updated'));
  }

  function markRead(item: AppNotification) {
    if (item.readAt) return;
    startTransition(async () => {
      const result = await markNotificationReadAction(item.id);
      if (!result.ok) {
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setItems((current) => current.map((candidate) =>
        candidate.id === item.id ? { ...candidate, readAt: new Date().toISOString() } : candidate));
      notifyHeader();
    });
  }

  function markAll() {
    startTransition(async () => {
      const result = await markAllNotificationsReadAction();
      if (!result.ok) {
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })));
      notifyHeader();
    });
  }

  return <div className="space-y-5">
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
      <strong className="text-amber-300">หมายเหตุ:</strong> ราคาที่แจ้งเป็นข้อมูลตลาดที่ระบบตรวจสอบได้ ไม่ใช่ราคาซื้อขายที่รับประกัน และระบบนี้ไม่ส่งคำสั่งซื้อขาย
    </section>
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">กล่องการแจ้งเตือน</h2>
        <p className="text-xs text-[var(--text-muted)]">ยังไม่ได้อ่าน {unread} รายการ</p>
      </div>
      {unread > 0 && <Button variant="outline" size="sm" onClick={markAll} isLoading={pending}>
        <CheckCheck size={16} className="mr-2" />อ่านทั้งหมด
      </Button>}
    </div>
    {items.length === 0
      ? <EmptyState className="panel" icon={Bell} title="ยังไม่มีการแจ้งเตือน" description="สรุปพอร์ตรายวันและราคาที่ถึงเป้าหมายจะแสดงที่นี่" />
      : <div className="space-y-3">
        {visibleItems.map((item) => <article
          key={item.id}
          className={`flex min-w-0 gap-4 rounded-2xl border p-4 ${item.readAt ? 'border-[var(--border)] bg-[var(--surface)] opacity-70' : 'border-[var(--border-strong)] bg-[var(--surface-elevated)]'}`}
        >
          <NotificationIcon type={item.type} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <strong className="break-words text-sm text-[var(--text)]">{item.title}</strong>
              <time className="shrink-0 text-xs text-[var(--text-muted)]" dateTime={item.createdAt}>{displayTime(item.createdAt)}</time>
            </div>
            <p className="mt-1 break-words text-sm leading-6 text-[var(--text-secondary)]">{maskedMessage(item, privacyMode)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {item.href && <Link
                href={item.href}
                onClick={() => markRead(item)}
                className="inline-flex min-h-11 items-center rounded-lg border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--text)] hover:border-[var(--accent)]"
              >
                เปิดดูรายละเอียด
              </Link>}
              {!item.readAt && <button
                type="button"
                disabled={pending}
                onClick={() => markRead(item)}
                className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                ทำเครื่องหมายว่าอ่านแล้ว
              </button>}
            </div>
          </div>
          {!item.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" aria-label="ยังไม่ได้อ่าน" />}
        </article>)}
        {visibleCount < items.length && <Button
          type="button"
          variant="outline"
          onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
          className="w-full"
        >
          แสดงรายการเพิ่มเติม
        </Button>}
      </div>}
  </div>;
}
