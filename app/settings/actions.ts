'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';

const timezoneSchema = z.enum([
  'Asia/Bangkok',
  'UTC',
  'America/New_York',
  'Europe/London',
]);

const settingsSchema = z.object({
  baseCurrency: z.enum(['THB', 'USD']),
  language: z.enum(['th', 'en']),
});

const notificationToggleSchema = z.object({
  setting: z.enum([
    'priceAlertsEnabled',
    'dailySummaryEnabled',
    'priceAlertExtendedHours',
    'quietHoursEnabled',
  ]),
  enabled: z.boolean(),
});

const notificationScheduleSchema = z.object({
  dailySummaryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: timezoneSchema,
}).refine((value) => value.quietHoursStart !== value.quietHoursEnd, {
  message: 'เวลาเริ่มและสิ้นสุดช่วงงดแจ้งเตือนต้องไม่ตรงกัน',
});

export type SettingsActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

async function authenticatedClient() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return { client, user };
}

export async function saveSettingsAction(formData: FormData): Promise<never> {
  const parsed = settingsSchema.safeParse({
    baseCurrency: formData.get('baseCurrency'),
    language: formData.get('language'),
  });
  if (!parsed.success) redirect('/settings?error=การตั้งค่าไม่ถูกต้อง');

  const authenticated = await authenticatedClient();
  if (!authenticated) redirect('/auth/sign-in?next=/settings&reason=session_expired');
  const { client, user } = authenticated;
  const { error } = await client.from('user_settings').upsert({
    user_id: user.id,
    base_currency: parsed.data.baseCurrency,
    language: parsed.data.language,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) redirect('/settings?error=ไม่สามารถบันทึกการตั้งค่าได้');

  const { error: portfolioError } = await client.rpc('set_portfolio_base_currency', {
    input_currency: parsed.data.baseCurrency,
  });
  if (portfolioError) redirect('/settings?error=ไม่สามารถบันทึกสกุลเงินของพอร์ตได้');
  redirect('/settings?message=บันทึกการตั้งค่าแล้ว');
}

export async function saveNotificationToggleAction(input: unknown): Promise<SettingsActionResult> {
  const parsed = notificationToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาลองใหม่' };
  const authenticated = await authenticatedClient();
  if (!authenticated) return { ok: false, message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };

  const update = parsed.data.setting === 'priceAlertsEnabled'
    ? { price_alerts_enabled: parsed.data.enabled }
    : parsed.data.setting === 'dailySummaryEnabled'
      ? { daily_summary_enabled: parsed.data.enabled }
      : parsed.data.setting === 'priceAlertExtendedHours'
        ? { price_alert_extended_hours: parsed.data.enabled }
        : { quiet_hours_enabled: parsed.data.enabled };
  const { error } = await authenticated.client.from('user_settings').upsert({
    user_id: authenticated.user.id,
    ...update,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return error
    ? { ok: false, message: 'บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง' }
    : { ok: true, message: 'บันทึกแล้ว' };
}

export async function saveNotificationScheduleAction(input: unknown): Promise<SettingsActionResult> {
  const parsed = notificationScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'เวลาแจ้งเตือนไม่ถูกต้อง',
    };
  }
  const authenticated = await authenticatedClient();
  if (!authenticated) return { ok: false, message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };

  const { error } = await authenticated.client.from('user_settings').upsert({
    user_id: authenticated.user.id,
    daily_summary_time: parsed.data.dailySummaryTime,
    quiet_hours_start: parsed.data.quietHoursStart,
    quiet_hours_end: parsed.data.quietHoursEnd,
    timezone: parsed.data.timezone,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return error
    ? { ok: false, message: 'บันทึกเวลาแจ้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง' }
    : { ok: true, message: 'บันทึกการแจ้งเตือนแล้ว' };
}
