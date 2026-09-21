import Header from '@/src/components/layout/Header';
import { AlertsClient } from '@/src/components/alerts/AlertsClient';
import { createClient } from '@/src/lib/supabase/server';
import { AlertsRepository } from '@/src/lib/alerts/repository';

export default async function AlertsPage() {
  const client = await createClient(); if (!client) return null;
  const { data: { user } } = await client.auth.getUser(); if (!user) return null;
  const alerts = await new AlertsRepository(client, user.id).list();
  /*
   * "การแจ้งเตือน" rather than "การแจ้งเตือนราคา" since `202609200001`: one of the
   * five conditions watches a DATE, not a price, so the narrower title would
   * name a page that is no longer only about prices.
   */
  return <div><Header title="การแจ้งเตือน" backFallbackHref="/settings" subtitle="ระบบตรวจให้อัตโนมัติทุก 15 นาที โดยใช้ข้อมูลราคาที่ผ่านเกณฑ์เดียวกับหน้าภาพรวมและหน้าพอร์ต" /><div className="mx-auto max-w-4xl p-4 md:p-8"><AlertsClient initialAlerts={alerts} /></div></div>;
}
