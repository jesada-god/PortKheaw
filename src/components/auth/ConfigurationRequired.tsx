import Link from 'next/link';
import { DatabaseZap } from 'lucide-react';

/**
 * Shown when the Supabase environment variables are absent. It renders on the
 * auth card as well as on the profile/settings pages, so its colours come from
 * the `--auth-*` tokens where those are defined and fall back to the app's own
 * palette everywhere else.
 */
export function ConfigurationRequired() {
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/40 bg-amber-400/10 p-4 text-sm leading-6"
      style={{ color: 'var(--auth-text, var(--text))' }}
    >
      <div className="flex items-start gap-3">
        <DatabaseZap aria-hidden="true" className="mt-0.5 shrink-0 text-amber-500" size={20} />
        <div>
          <p className="font-semibold">ต้องตั้งค่า Supabase ก่อน</p>
          <p className="mt-1">
            เพิ่ม NEXT_PUBLIC_SUPABASE_URL และ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ใน .env.local แล้วรีสตาร์ท dev server
          </p>
        </div>
      </div>
      <Link
        href="/"
        className="mt-4 inline-flex min-h-11 items-center font-semibold underline-offset-4 hover:underline"
        style={{ color: 'var(--auth-primary, var(--accent))' }}
      >
        กลับไปดูหน้าตลาดสาธารณะ
      </Link>
    </div>
  );
}
