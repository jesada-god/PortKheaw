'use client';

import { useActionState, useState } from 'react';
import { Lock } from 'lucide-react';
import { resetPasswordAction } from '@/app/auth/actions';
import { IDLE_AUTH_STATE } from '@/src/lib/auth/form-state';
import { PasswordField } from './AuthField';
import { AuthBanner, AuthSubmitButton } from './AuthControls';

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(resetPasswordAction, IDLE_AUTH_STATE);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  return (
    <>
      <AuthBanner error={state.status === 'error' ? state.message : undefined} />
      <form action={formAction} className="space-y-4" noValidate>
        <PasswordField
          name="password"
          label="รหัสผ่านใหม่"
          autoComplete="new-password"
          placeholder="ตั้งรหัสผ่านใหม่"
          required
          showChecklist
          value={password}
          onValueChange={setPassword}
          error={state.fieldErrors?.password}
          icon={<Lock size={18} />}
        />
        <PasswordField
          name="confirmPassword"
          label="ยืนยันรหัสผ่านใหม่"
          autoComplete="new-password"
          placeholder="พิมพ์รหัสผ่านใหม่อีกครั้ง"
          required
          value={confirmPassword}
          onValueChange={setConfirmPassword}
          error={state.fieldErrors?.confirmPassword}
          icon={<Lock size={18} />}
        />
        <AuthSubmitButton pendingLabel="กำลังบันทึก…">บันทึกรหัสผ่านใหม่</AuthSubmitButton>
      </form>
    </>
  );
}
