import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { AuthMessage } from '@/src/components/auth/AuthMessage';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { createClient } from '@/src/lib/supabase/server';
import { saveSettingsAction } from './actions';
import { DevicePreferences } from '@/src/components/settings/DevicePreferences';
import { PushPreferences } from '@/src/components/settings/PushPreferences';
import { ThemeControls } from '@/src/themes/ThemeControls';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const supabase = await createClient();
  if (!supabase) return <><Header title="การตั้งค่า (Settings)" /><div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div></>;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/settings');
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', user.id).maybeSingle();
  const settings = data ?? { base_currency: 'USD' as const, language: 'th' as const, price_alerts_enabled: true, daily_summary_enabled: true,
    push_enabled: false, quiet_hours_enabled: false, quiet_hours_start: '22:00:00', quiet_hours_end: '07:00:00', timezone: 'Asia/Bangkok' };
  const error = typeof params.error === 'string' ? params.error : undefined;
  const message = typeof params.message === 'string' ? params.message : undefined;

  return (
    <div>
      <Header title="การตั้งค่า (Settings)" subtitle="ปรับแต่งการแสดงผล" />
      <form action={saveSettingsAction} className="p-4 md:p-8 max-w-2xl mx-auto space-y-8">
        <AuthMessage error={error} message={message} />
        <section className="space-y-4"><h2 className="text-lg font-semibold text-[var(--text)]">แสดงผล (Display)</h2><div className="space-y-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
          <ThemeControls />
          <div className="space-y-6 border-t border-[var(--border)] pt-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><label htmlFor="baseCurrency" className="font-medium text-[var(--text)]">สกุลเงินหลัก</label><p className="text-xs text-[var(--text-muted)]">ใช้ในการแสดงมูลค่าพอร์ต</p></div><div className="w-full sm:w-36"><Select id="baseCurrency" name="baseCurrency" defaultValue={settings.base_currency}><option value="THB">THB (฿)</option><option value="USD">USD ($)</option></Select></div></div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><label htmlFor="language" className="font-medium text-[var(--text)]">ภาษา</label><div className="w-full sm:w-36"><Select id="language" name="language" defaultValue={settings.language}><option value="th">ไทย</option><option value="en">English</option></Select></div></div>
          </div>
        </div></section>
        <DevicePreferences />
        <section className="space-y-4"><h2 className="text-lg font-semibold text-white">การแจ้งเตือน</h2><div className="bg-[#151B28] rounded-2xl border border-slate-800 p-5 sm:p-6 space-y-4 text-slate-300 text-sm">
          <label className="flex min-h-11 items-center justify-between gap-4"><span>ราคาถึงเป้าหมาย</span><input name="priceAlertsEnabled" type="checkbox" defaultChecked={settings.price_alerts_enabled} className="h-5 w-5 accent-[#D4FF00]" /></label>
          <label className="flex min-h-11 items-center justify-between gap-4"><span>สรุปตลาดรายวัน</span><input name="dailySummaryEnabled" type="checkbox" defaultChecked={settings.daily_summary_enabled} className="h-5 w-5 accent-[#D4FF00]" /></label>
          <PushPreferences />
          <div className="space-y-3 border-t border-slate-800 pt-4">
            <label className="flex min-h-11 items-center justify-between gap-4"><span>Quiet hours</span><input name="quietHoursEnabled" type="checkbox" defaultChecked={settings.quiet_hours_enabled} className="h-5 w-5 accent-[#D4FF00]" /></label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1"><span className="text-xs text-slate-400">เริ่ม</span><input name="quietHoursStart" type="time" defaultValue={settings.quiet_hours_start.slice(0, 5)} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
              <label className="space-y-1"><span className="text-xs text-slate-400">สิ้นสุด</span><input name="quietHoursEnd" type="time" defaultValue={settings.quiet_hours_end.slice(0, 5)} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
              <label className="space-y-1"><span className="text-xs text-slate-400">เขตเวลา</span><select name="timezone" defaultValue={settings.timezone} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="Asia/Bangkok">Bangkok</option><option value="UTC">UTC</option><option value="America/New_York">New York</option><option value="Europe/London">London</option></select></label>
            </div>
            <p className="text-xs text-slate-500">Push ที่เกิดในช่วง Quiet hours จะรอส่งหลังช่วงเงียบ ระบบยังบันทึก notification ไว้ตามปกติ</p>
          </div>
        </div></section>
        <div className="pt-4 border-t border-slate-800 flex justify-end"><Button type="submit" size="lg" className="w-full sm:w-auto">บันทึกการตั้งค่า</Button></div>
      </form>
    </div>
  );
}
