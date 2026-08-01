import Header from '@/src/components/layout/Header';
import { AlertsClient } from '@/src/components/alerts/AlertsClient';
import { createClient } from '@/src/lib/supabase/server';
import { AlertsRepository } from '@/src/lib/alerts/repository';

export default async function AlertsPage() {
  const client = await createClient(); if (!client) return null;
  const { data: { user } } = await client.auth.getUser(); if (!user) return null;
  const alerts = await new AlertsRepository(client, user.id).list();
  return <div><Header title="การแจ้งเตือนราคา (Alerts)" subtitle="ระบบตรวจราคาตามรอบอัตโนมัติ โดยใช้ข้อมูลราคาที่ผ่านเกณฑ์เดียวกับหน้า Overview และ Portfolio" /><div className="mx-auto max-w-4xl p-4 md:p-8"><AlertsClient initialAlerts={alerts} /></div></div>;
}
