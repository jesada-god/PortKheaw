import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { BarChart3, ShieldCheck, Lightbulb } from 'lucide-react';
import { AuthShell, AuthWordmark, AUTH_TAGLINE } from '@/src/components/auth/AuthShell';
import { KheawMascot } from '@/src/components/auth/KheawMascot';
import { getEnabledAuthProviders } from '@/src/lib/auth/providers';
import { getSafeReturnPath } from '@/src/lib/auth/paths';


/*
 * Loaded as its own chunk, and only requested when the provider is actually
 * enabled — so the Supabase browser client never ships to visitors who are
 * only ever shown the email form.
 */
const GoogleAuthButton = dynamic(() => import('@/src/components/auth/GoogleAuthButton').then((module) => module.GoogleAuthButton));

export const metadata: Metadata = { title: 'ยินดีต้อนรับ' };

const BENEFITS = [
  { icon: BarChart3, title: 'ติดตามข้อมูลพอร์ต', detail: 'ดูสัดส่วนและผลตอบแทนของพอร์ตที่คุณบันทึกไว้' },
  { icon: Lightbulb, title: 'ดูข้อมูลประกอบการตัดสินใจ', detail: 'ราคา กราฟ และสถิติที่ใช้ประกอบการพิจารณา' },
  { icon: ShieldCheck, title: 'จัดการบัญชีอย่างปลอดภัย', detail: 'ข้อมูลของแต่ละบัญชีแยกจากกันด้วยสิทธิ์ระดับแถว' },
];

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = getSafeReturnPath(typeof params.next === 'string' ? params.next : null);
  const providers = await getEnabledAuthProviders();

  return (
    <AuthShell width="wide">
      <div className="text-center">
        <AuthWordmark className="text-[2.4rem] sm:text-[2.8rem]" />
        <p className="mt-1 text-sm" style={{ color: 'var(--auth-on-field-muted)' }}>{AUTH_TAGLINE}</p>
      </div>

      <div className="mt-6 flex justify-center" data-auth-rise>
        <KheawMascot size="lg" priority />
      </div>

      <div className="mt-5 text-center">
        <h1 className="text-2xl font-bold sm:text-[1.75rem]" style={{ color: 'var(--auth-on-field)' }}>
          ยินดีต้อนรับสู่ PortKheaw
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6" style={{ color: 'var(--auth-on-field-muted)' }}>
          ติดตามพอร์ตและดูข้อมูลประกอบการลงทุนได้ในที่เดียว
        </p>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {BENEFITS.map(({ icon: Icon, title, detail }) => (
          <li
            key={title}
            className="rounded-2xl p-3.5 text-center"
            style={{
              background: 'rgba(255,255,255,0.10)',
              border: '1px solid rgba(255,255,255,0.16)',
              color: 'var(--auth-on-field)',
            }}
          >
            <Icon aria-hidden="true" size={22} className="mx-auto" style={{ color: 'var(--auth-decor)' }} />
            <p className="mt-2 text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs leading-5" style={{ color: 'var(--auth-on-field-muted)' }}>{detail}</p>
          </li>
        ))}
      </ul>

      <div className="mt-7 space-y-3">
        <Link
          href={`/auth/sign-up?next=${encodeURIComponent(next)}`}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl px-5 text-base font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-decor)]"
          style={{ background: 'var(--auth-on-field)', color: 'var(--auth-field-top)' }}
        >
          เริ่มต้นใช้งาน
        </Link>

        {/* Rendered only while Google is genuinely switched on for this project. */}
        {providers.google ? <GoogleAuthButton next={next} label="ดำเนินการต่อด้วย Google" /> : null}

        {/* A real target, not 19px of inline text: this is the path an existing
            user takes on every visit. */}
        <p className="flex flex-wrap items-center justify-center gap-1 pt-1 text-sm" style={{ color: 'var(--auth-on-field-muted)' }}>
          <span>มีบัญชีอยู่แล้ว?</span>
          <Link
            href={`/auth/sign-in?next=${encodeURIComponent(next)}`}
            className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-decor)]"
            style={{ color: 'var(--auth-on-field)' }}
          >
            เข้าสู่ระบบ
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
