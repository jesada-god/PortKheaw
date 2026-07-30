'use client';

import { useActionState, useState } from 'react';
import { Mail } from 'lucide-react';
import { forgotPasswordAction } from '@/app/auth/actions';
import { IDLE_AUTH_STATE } from '@/src/lib/auth/form-state';
import { AuthField } from './AuthField';
import { AuthLink, AuthMailSentPanel, AuthBanner, AuthSubmitButton, ResendCooldown } from './AuthControls';

/**
 * The neutral half of "one email, one account".
 *
 * Whatever the server finds — no account, a password account, an account that
 * only signs in with Google — this form ends on the same sentence. Anything
 * that varied with the answer would turn the page into a way to test which
 * addresses are registered and how they sign in.
 */
export const NEUTRAL_RECOVERY_MESSAGE = 'หากบัญชีนี้รองรับการตั้งรหัสผ่านใหม่ เราจะส่งคำแนะนำไปยังอีเมลของคุณ';

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(forgotPasswordAction, IDLE_AUTH_STATE);
  const [email, setEmail] = useState(state.values?.email ?? '');

  if (state.status === 'recovery-sent') {
    return (
      <AuthMailSentPanel
        title="ตรวจสอบอีเมลของคุณ"
        email={state.email}
        description={NEUTRAL_RECOVERY_MESSAGE}
      >
        <ResendCooldown seconds={60}>
          <form action={formAction}>
            <input type="hidden" name="email" value={state.email ?? ''} />
            <AuthSubmitButton pendingLabel="กำลังส่ง…">ส่งอีเมลอีกครั้ง</AuthSubmitButton>
          </form>
        </ResendCooldown>
        <div className="mt-4">
          <AuthLink href="/auth/sign-in">กลับไปหน้าเข้าสู่ระบบ</AuthLink>
        </div>
      </AuthMailSentPanel>
    );
  }

  return (
    <>
      <AuthBanner error={state.status === 'error' ? state.message : undefined} />
      <form action={formAction} className="space-y-4" noValidate>
        <AuthField
          name="email"
          label="อีเมล"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="example@email.com"
          required
          value={email}
          onValueChange={setEmail}
          error={state.fieldErrors?.email}
          icon={<Mail size={18} />}
        />
        <AuthSubmitButton pendingLabel="กำลังส่ง…">ส่งลิงก์ตั้งรหัสผ่านใหม่</AuthSubmitButton>
      </form>
    </>
  );
}
