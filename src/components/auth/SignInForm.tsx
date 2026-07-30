'use client';

import { useActionState, useState } from 'react';
import { Lock, Mail } from 'lucide-react';
import { signInAction } from '@/app/auth/actions';
import { IDLE_AUTH_STATE } from '@/src/lib/auth/form-state';
import { AuthField, PasswordField } from './AuthField';
import { AuthLink, AuthBanner, AuthSubmitButton } from './AuthControls';

export function SignInForm({ next, initialError, initialMessage }: { next: string; initialError?: string; initialMessage?: string }) {
  const [state, formAction] = useActionState(signInAction, IDLE_AUTH_STATE);
  const [email, setEmail] = useState(state.values?.email ?? '');
  const [password, setPassword] = useState('');

  // A message carried in the URL (session expired, signed out, password reset)
  // only shows until the visitor's own attempt produces a newer one.
  const bannerError = state.status === 'error' ? state.message : initialError;
  const bannerMessage = state.status === 'error' ? undefined : initialMessage;

  return (
    <>
      <AuthBanner error={bannerError} message={bannerMessage} />
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />
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
        <div>
          <PasswordField
            name="password"
            label="รหัสผ่าน"
            autoComplete="current-password"
            placeholder="รหัสผ่านของคุณ"
            required
            value={password}
            onValueChange={setPassword}
            error={state.fieldErrors?.password}
            icon={<Lock size={18} />}
          />
          <div className="mt-1 flex justify-end">
            <AuthLink href="/auth/forgot-password">ลืมรหัสผ่าน?</AuthLink>
          </div>
        </div>
        <AuthSubmitButton pendingLabel="กำลังเข้าสู่ระบบ…">เข้าสู่ระบบ</AuthSubmitButton>
      </form>
    </>
  );
}
