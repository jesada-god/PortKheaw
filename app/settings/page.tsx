import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { AuthMessage } from '@/src/components/auth/AuthMessage';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { createClient } from '@/src/lib/supabase/server';
import { saveSettingsAction } from './actions';
import { DevicePreferences } from '@/src/components/settings/DevicePreferences';
import { NotificationPreferences } from '@/src/components/settings/NotificationPreferences';
import { ThemeControls } from '@/src/themes/ThemeControls';

export default async function SettingsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  if (!supabase) {
    return <>
      <Header title="การตั้งค่า" />
      <div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div>
    </>;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/settings');
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', user.id).maybeSingle();
  const settings = data ?? {
    base_currency: 'USD' as const,
    language: 'th' as const,
    price_alerts_enabled: true,
    daily_summary_enabled: true,
    daily_summary_time: '18:00:00',
    price_alert_extended_hours: false,
    quiet_hours_enabled: false,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '07:00:00',
    timezone: 'Asia/Bangkok',
  };
  const error = typeof params.error === 'string' ? params.error : undefined;
  const message = typeof params.message === 'string' ? params.message : undefined;

  return <div>
    <Header title="การตั้งค่า" subtitle="เลือกการแสดงผลและการแจ้งเตือนที่เหมาะกับคุณ" />
    <main className="mx-auto max-w-2xl space-y-8 p-4 md:p-8">
      <form action={saveSettingsAction} className="space-y-5">
        <AuthMessage error={error} message={message} />
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-[var(--text)]">การแสดงผล</h2>
          <div className="space-y-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
            <ThemeControls />
            <div className="space-y-6 border-t border-[var(--border)] pt-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <label htmlFor="baseCurrency" className="font-medium text-[var(--text)]">สกุลเงินหลัก</label>
                  <p className="text-xs text-[var(--text-muted)]">ใช้แสดงมูลค่าพอร์ต</p>
                </div>
                <div className="w-full sm:w-40">
                  <Select id="baseCurrency" name="baseCurrency" defaultValue={settings.base_currency}>
                    <option value="THB">THB (฿)</option>
                    <option value="USD">USD ($)</option>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="language" className="font-medium text-[var(--text)]">ภาษา</label>
                <div className="w-full sm:w-40">
                  <Select id="language" name="language" defaultValue={settings.language}>
                    <option value="th">ไทย</option>
                    <option value="en">English</option>
                  </Select>
                </div>
              </div>
            </div>
            <div className="flex justify-end border-t border-[var(--border)] pt-5">
              <Button type="submit" className="w-full sm:w-auto">บันทึกการตั้งค่าทั่วไป</Button>
            </div>
          </div>
        </section>
      </form>

      <DevicePreferences />

      <NotificationPreferences initial={{
        priceAlertsEnabled: settings.price_alerts_enabled,
        dailySummaryEnabled: settings.daily_summary_enabled,
        priceAlertExtendedHours: settings.price_alert_extended_hours ?? false,
        quietHoursEnabled: settings.quiet_hours_enabled,
        dailySummaryTime: settings.daily_summary_time.slice(0, 5),
        quietHoursStart: settings.quiet_hours_start.slice(0, 5),
        quietHoursEnd: settings.quiet_hours_end.slice(0, 5),
        timezone: settings.timezone as 'Asia/Bangkok' | 'UTC' | 'America/New_York' | 'Europe/London',
      }} />
    </main>
  </div>;
}
