import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { AuthCard, AuthHeader, AuthShell, AuthTitle } from '@/src/components/auth/AuthShell';
import { KheawMascot } from '@/src/components/auth/KheawMascot';
import { AuthDivider, AuthLink } from '@/src/components/auth/AuthControls';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { SignInForm } from '@/src/components/auth/SignInForm';
import { isSupabaseConfigured } from '@/src/config/env/client';
import { getSafeReturnPath } from '@/src/lib/auth/paths';
import { getEnabledAuthProviders } from '@/src/lib/auth/providers';


/*
 * Loaded as its own chunk, and only requested when the provider is actually
 * enabled — so the Supabase browser client never ships to visitors who are
 * only ever shown the email form.
 */
const GoogleAuthButton = dynamic(() => import('@/src/components/auth/GoogleAuthButton').then((module) => module.GoogleAuthButton));

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = getSafeReturnPath(typeof params.next === 'string' ? params.next : null);
  const error = typeof params.error === 'string' ? params.error : undefined;
  const message = typeof params.message === 'string' ? params.message : undefined;
  const expired = params.reason === 'session_expired';
  const providers = isSupabaseConfigured ? await getEnabledAuthProviders() : { google: false };

  return (
    <AuthShell>
      <AuthHeader />
      <AuthCard>
        <AuthTitle title="เข้าสู่ระบบ" description="เข้าสู่ระบบเพื่อดูและจัดการพอร์ตของคุณ" />
        {!isSupabaseConfigured ? <ConfigurationRequired /> : (
          <>
            <SignInForm
              next={next}
              initialError={error ?? (expired ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง' : undefined)}
              initialMessage={message}
            />
            {providers.google ? (
              <>
                <AuthDivider />
                <GoogleAuthButton next={next} label="เข้าสู่ระบบด้วย Google" />
              </>
            ) : null}
            <p className="mt-5 flex flex-wrap items-center justify-center gap-1 text-sm" style={{ color: 'var(--auth-text-secondary)' }}>
              <span>ยังไม่มีบัญชี?</span>
              <AuthLink href={`/auth/sign-up?next=${encodeURIComponent(next)}`}>สร้างบัญชีใหม่</AuthLink>
            </p>
          </>
        )}
      </AuthCard>
      <div className="mt-5 flex items-center justify-center gap-3">
        <KheawMascot size="sm" />
        <p
          className="max-w-[15rem] rounded-2xl px-3.5 py-2 text-xs leading-5"
          style={{ background: 'rgba(255,255,255,0.12)', color: 'var(--auth-on-field)' }}
        >
          ให้ Kheaw ช่วยดูแลพอร์ตของคุณนะ
        </p>
      </div>
    </AuthShell>
  );
}
