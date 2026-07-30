'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, Bell, CheckCheck } from 'lucide-react';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/notifications/actions';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useToast } from '@/src/components/ui/Toast';
import type { AppNotification } from '@/src/lib/alerts/types';

const displayTime = (value: string) => new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
}).format(new Date(value));

export function NotificationsClient({ initialNotifications }: { initialNotifications: AppNotification[] }) {
  const [items, setItems] = useState(initialNotifications);
  const [pending, startTransition] = useTransition();
  const { addToast } = useToast();
  const unread = items.filter((item) => !item.readAt).length;

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
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
      <strong className="text-amber-300">หมายเหตุ:</strong> Price Alert และเป้าหมายออปชันในพอร์ตประเมินเมื่อระบบตรวจข้อมูลหรือเมื่อเปิด/รีเฟรชหน้าที่เกี่ยวข้อง ไม่ใช่ราคาซื้อขายที่รับประกัน และไม่ส่งคำสั่งซื้อขาย
    </section>
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-white">Notification Center</h2><p className="text-xs text-slate-500">ยังไม่ได้อ่าน {unread} รายการ</p></div>
      {unread > 0 && <Button variant="outline" size="sm" onClick={markAll} isLoading={pending}><CheckCheck size={16} className="mr-2" />อ่านทั้งหมด</Button>}
    </div>
    {items.length === 0
      ? <div className="rounded-2xl border border-slate-800 bg-[#151B28]"><EmptyState icon={Bell} title="ไม่มีการแจ้งเตือน" description="เมื่อ Alert หรือเป้าหมายในพอร์ตตรงเงื่อนไข รายการจะปรากฏที่นี่" /></div>
      : <div className="space-y-3">{items.map((item) => <button
        key={item.id}
        disabled={Boolean(item.readAt) || pending}
        onClick={() => markRead(item)}
        className={`flex min-h-11 w-full gap-4 rounded-2xl border p-4 text-left transition-colors ${item.readAt ? 'border-slate-800 bg-[#151B28] opacity-65' : 'border-slate-700 bg-slate-800/80 hover:border-[#D4FF00]/50'}`}
      >
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={20} />
        <span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><strong className="text-sm text-white">{item.title}</strong><span className="shrink-0 text-[10px] text-slate-500">{displayTime(item.createdAt)}</span></span><span className="mt-1 block text-sm text-slate-400">{item.message}</span></span>
        {!item.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#D4FF00]" />}
      </button>)}</div>}
  </div>;
}
