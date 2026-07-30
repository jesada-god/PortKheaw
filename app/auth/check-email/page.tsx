import type { Metadata } from 'next';
import { AuthCard, AuthHeader, AuthShell } from '@/src/components/auth/AuthShell';
import { AuthLink, AuthMailSentPanel } from '@/src/components/auth/AuthControls';
import { NEUTRAL_RECOVERY_MESSAGE } from '@/src/components/auth/ForgotPasswordForm';

export const metadata: Metadata = { title: 'ตรวจสอบอีเมล' };

/**
 * Kept as a route because older confirmation mails and bookmarks point at it.
 * The sign-up and recovery flows now show this state inline instead, which
 * keeps the address out of the URL bar and browser history.
 */
export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const email = typeof params.email === 'string' ? params.email : undefined;
  const isReset = params.reset === '1';

  return (
    <AuthShell>
      <AuthHeader compact />
      <AuthCard>
        <AuthMailSentPanel
          title="ตรวจสอบอีเมลของคุณ"
          // This panel is the whole page here, so it carries the page heading.
          headingLevel="h1"
          email={email}
          description={isReset
            ? NEUTRAL_RECOVERY_MESSAGE
            : 'เราส่งลิงก์ยืนยันไปยังอีเมลของคุณแล้ว กรุณากดลิงก์ในอีเมลเพื่อเปิดใช้งานบัญชี'}
        >
          <div className="mt-5">
            <AuthLink href="/auth/sign-in">กลับไปหน้าเข้าสู่ระบบ</AuthLink>
          </div>
        </AuthMailSentPanel>
      </AuthCard>
    </AuthShell>
  );
}
