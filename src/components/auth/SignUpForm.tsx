'use client';

import { useActionState, useState } from 'react';
import { Lock, Mail, User } from 'lucide-react';
import { signUpAction } from '@/app/auth/actions';
import { IDLE_AUTH_STATE } from '@/src/lib/auth/form-state';
import { AuthField, PasswordField } from './AuthField';
import { AuthLink, AuthMailSentPanel, AuthBanner, AuthSubmitButton } from './AuthControls';

export function SignUpForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(signUpAction, IDLE_AUTH_STATE);
  const [fullName, setFullName] = useState(state.values?.fullName ?? '');
  const [email, setEmail] = useState(state.values?.email ?? '');
  const [password, setPassword] = useState('');

  // Sign-up does not hand back a session while this project requires email
  // confirmation, so success is a "go and confirm" screen — never a redirect
  // that would look like being signed in.
  if (state.status === 'verification-sent') {
    return (
      <AuthMailSentPanel
        title="ยืนยันอีเมลของคุณ"
        email={state.email}
        description="เราส่งลิงก์ยืนยันไปยังอีเมลนี้แล้ว กรุณากดลิงก์ในอีเมลเพื่อเปิดใช้งานบัญชี หากไม่พบ ลองตรวจในกล่องจดหมายขยะ"
      >
        <div className="mt-5">
          <AuthLink href="/auth/sign-in">กลับไปหน้าเข้าสู่ระบบ</AuthLink>
        </div>
      </AuthMailSentPanel>
    );
  }

  return (
    <>
      <AuthBanner error={state.status === 'error' ? state.message : undefined} />
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />
        <AuthField
          name="fullName"
          label="ชื่อที่แสดง"
          autoComplete="name"
          placeholder="ตั้งชื่อที่จะแสดงในแอป"
          maxLength={100}
          required
          value={fullName}
          onValueChange={setFullName}
          error={state.fieldErrors?.fullName}
          icon={<User size={18} />}
        />
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
        <PasswordField
          name="password"
          label="รหัสผ่าน"
          autoComplete="new-password"
          placeholder="ตั้งรหัสผ่านของคุณ"
          required
          showChecklist
          value={password}
          onValueChange={setPassword}
          error={state.fieldErrors?.password}
          icon={<Lock size={18} />}
        />
        <AuthSubmitButton pendingLabel="กำลังสร้างบัญชี…">สร้างบัญชี</AuthSubmitButton>
      </form>
    </>
  );
}
