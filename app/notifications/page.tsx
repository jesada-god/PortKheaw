import Header from '@/src/components/layout/Header';
import { NotificationsClient } from '@/src/components/alerts/NotificationsClient';
import { NotificationsRepository } from '@/src/lib/alerts/repository';
import { createClient } from '@/src/lib/supabase/server';

export default async function NotificationsPage() {
  const client = await createClient(); if (!client) return null;
  const { data: { user } } = await client.auth.getUser(); if (!user) return null;
  const notifications = await new NotificationsRepository(client, user.id).list();
  return <div><Header title="การแจ้งเตือน" subtitle="สรุปพอร์ตและราคาเป้าหมายของคุณ" /><div className="mx-auto max-w-3xl p-4 md:p-8"><NotificationsClient initialNotifications={notifications} /></div></div>;
}

