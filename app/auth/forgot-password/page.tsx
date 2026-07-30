import type { Metadata } from 'next';
import { AuthCard, AuthHeader, AuthShell, AuthTitle } from '@/src/components/auth/AuthShell';
import { AuthLink } from '@/src/components/auth/AuthControls';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { ForgotPasswordForm } from '@/src/components/auth/ForgotPasswordForm';
import { isSupabaseConfigured } from '@/src/config/env/client';

export const metadata: Metadata = { title: 'ลืมรหัสผ่าน' };

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <AuthHeader compact />
      <AuthCard>
        <AuthTitle
          title="ลืมรหัสผ่าน"
          description="กรอกอีเมลที่ใช้สมัคร แล้วเราจะส่งขั้นตอนการตั้งรหัสผ่านใหม่ไปให้"
        />
        {!isSupabaseConfigured ? <ConfigurationRequired /> : (
          <>
            <ForgotPasswordForm />
            <div className="mt-5 text-center">
              <AuthLink href="/auth/sign-in">กลับไปหน้าเข้าสู่ระบบ</AuthLink>
            </div>
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
}
