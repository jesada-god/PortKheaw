import { redirect } from 'next/navigation';
import { User, Settings, ChevronRight, Shield, BellRing } from 'lucide-react';
import Link from 'next/link';
import Header from '@/src/components/layout/Header';
import { AuthMessage } from '@/src/components/auth/AuthMessage';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { AccountActions } from '@/src/components/auth/AccountActions';
import { createClient } from '@/src/lib/supabase/server';

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const supabase = await createClient();
  if (!supabase) return <><Header title="โปรไฟล์ (Profile)" /><div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div></>;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/profile');
  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const metadataName = typeof user.user_metadata.full_name === 'string' ? user.user_metadata.full_name : null;
  const fullName = profile?.full_name || metadataName || user.email?.split('@')[0] || 'PortKheaw User';
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <div>
      <Header title="โปรไฟล์ (Profile)" />
      <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <AuthMessage error={error} />
        <div className="bg-[#151B28] rounded-2xl border border-slate-800 p-5 sm:p-6 flex items-center gap-4 sm:gap-6">
          <div className="w-16 h-16 sm:w-20 sm:h-20 shrink-0 rounded-full bg-slate-800 border-2 border-[#D4FF00] flex items-center justify-center text-slate-400"><User size={36} /></div>
          <div className="min-w-0"><h2 className="truncate text-xl sm:text-2xl font-bold text-white">{fullName}</h2><p className="truncate text-sm text-slate-400">{user.email}</p><span className="mt-2 inline-flex rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">Authenticated</span></div>
        </div>

        <div className="bg-[#151B28] rounded-2xl border border-slate-800 overflow-hidden">
          <Link href="/settings" className="flex min-h-14 items-center justify-between p-4 border-b border-slate-800 hover:bg-slate-800/50 transition-colors"><span className="flex items-center gap-3 text-slate-300"><Settings size={20} className="text-slate-400" />การตั้งค่าแอป</span><ChevronRight size={16} className="text-slate-500" /></Link>
          <Link href="/alerts" className="flex min-h-14 items-center justify-between p-4 border-b border-slate-800 hover:bg-slate-800/50 transition-colors"><span className="flex items-center gap-3 text-slate-300"><BellRing size={20} className="text-slate-400" />การแจ้งเตือนราคา</span><ChevronRight size={16} className="text-slate-500" /></Link>
          <div className="flex min-h-14 items-center gap-3 p-4 text-slate-300"><Shield size={20} className="text-slate-400" /><span>บัญชีได้รับการป้องกันด้วย Supabase Auth</span></div>
        </div>
        <AccountActions />
      </div>
    </div>
  );
}
