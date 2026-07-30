import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { AuthCard, AuthHeader, AuthShell, AuthTitle } from '@/src/components/auth/AuthShell';
import { AuthLink } from '@/src/components/auth/AuthControls';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { ResetPasswordForm } from '@/src/components/auth/ResetPasswordForm';
import { isSupabaseConfigured } from '@/src/config/env/client';
import { createClient } from '@/src/lib/supabase/server';
import { RECOVERY_CONTEXT_MESSAGE, resolveRecoveryContext } from '@/src/lib/auth/recovery-context';

export const metadata: Metadata = { title: 'ตั้งรหัสผ่านใหม่' };

/**
 * The form is rendered only for a session that Supabase itself says came from a
 * recovery link, on an account that has a password identity. Opening this URL
 * directly — with or without an ordinary session, with or without invented
 * query parameters — reaches the explanation below instead of a password field.
 */
export default async function ResetPasswordPage() {
  if (!isSupabaseConfigured) {
    return (
      <AuthShell>
        <AuthHeader compact />
        <AuthCard><ConfigurationRequired /></AuthCard>
      </AuthShell>
    );
  }

  const supabase = await createClient();
  const context = supabase ? await resolveRecoveryContext(supabase) : 'no-session';

  return (
    <AuthShell>
      <AuthHeader compact />
      <AuthCard>
        {context === 'ready' ? (
          <>
            <AuthTitle title="ตั้งรหัสผ่านใหม่" description="ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ" />
            <ResetPasswordForm />
          </>
        ) : (
          <div className="text-center">
            <span
              aria-hidden="true"
              className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: 'var(--auth-danger-surface)', color: 'var(--auth-danger)' }}
            >
              <AlertTriangle size={26} />
            </span>
            <h1 className="text-lg font-bold" style={{ color: 'var(--auth-text)' }}>ตั้งรหัสผ่านใหม่ไม่ได้</h1>
            <p role="status" className="mt-2 text-sm leading-6" style={{ color: 'var(--auth-text-secondary)' }}>
              {RECOVERY_CONTEXT_MESSAGE[context]}
            </p>
            <div className="mt-5 flex flex-col items-center gap-1">
              {context === 'oauth-only' ? null : <AuthLink href="/auth/forgot-password">ขอลิงก์ใหม่อีกครั้ง</AuthLink>}
              <AuthLink href="/auth/sign-in">กลับไปหน้าเข้าสู่ระบบ</AuthLink>
            </div>
          </div>
        )}
      </AuthCard>
    </AuthShell>
  );
}
