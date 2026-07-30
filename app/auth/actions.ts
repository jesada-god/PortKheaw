'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { getSafeReturnPath } from '@/src/lib/auth/paths';
import { describeAuthError } from '@/src/lib/auth/errors';
import { evaluatePassword } from '@/src/lib/auth/password-policy';
import { RECOVERY_CONTEXT_MESSAGE, resolveRecoveryContext } from '@/src/lib/auth/recovery-context';
import type { AuthFormState } from '@/src/lib/auth/form-state';

const emailSchema = z.email('กรุณากรอกอีเมลให้ถูกต้อง');
const fullNameSchema = z.string().trim().min(1, 'กรุณากรอกชื่อที่แสดง').max(100, 'ชื่อต้องไม่เกิน 100 ตัวอักษร');

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function invalid(message: string, state: Omit<AuthFormState, 'status' | 'message'> = {}): AuthFormState {
  return { status: 'error', message, ...state };
}

/**
 * The absolute URL Supabase is told to send the visitor back to.
 *
 * Built from the request's own origin — never from a query parameter — so a
 * crafted link cannot make the confirmation or recovery mail point at another
 * site. The value still has to appear in the project's Redirect URL allow-list;
 * Supabase falls back to the Site URL for anything that does not.
 */
async function callbackUrl(next: string): Promise<string | undefined> {
  const headerStore = await headers();
  const origin = headerStore.get('origin');
  const forwardedHost = headerStore.get('x-forwarded-host') ?? headerStore.get('host');
  const forwardedProto = headerStore.get('x-forwarded-proto') ?? 'https';
  const base = origin ?? (forwardedHost ? `${forwardedProto}://${forwardedHost}` : null);
  if (!base) return undefined;
  try {
    const url = new URL('/auth/callback', base);
    url.searchParams.set('next', next);
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function signInAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const next = getSafeReturnPath(formData.get('next'));
  const email = text(formData.get('email')).trim();
  const password = text(formData.get('password'));

  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { email: 'กรุณากรอกอีเมลให้ถูกต้อง' },
      values: { email },
    });
  }
  if (!password) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { password: 'กรุณากรอกรหัสผ่าน' },
      values: { email },
    });
  }

  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');

  // Existing accounts predate the current policy, so sign-in validates only that
  // a password was typed — the policy applies where a password is *created*.
  const { error } = await supabase.auth.signInWithPassword({ email: parsedEmail.data, password });
  if (error) return invalid(describeAuthError(error, 'sign-in'), { values: { email } });

  redirect(next);
}

export async function signUpAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const next = getSafeReturnPath(formData.get('next'));
  const rawFullName = text(formData.get('fullName'));
  const email = text(formData.get('email')).trim();
  const password = text(formData.get('password'));
  const values = { fullName: rawFullName, email };

  const parsedName = fullNameSchema.safeParse(rawFullName);
  if (!parsedName.success) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { fullName: parsedName.error.issues[0]?.message ?? 'กรุณากรอกชื่อที่แสดง' },
      values,
    });
  }
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { email: 'กรุณากรอกอีเมลให้ถูกต้อง' },
      values,
    });
  }
  const policy = evaluatePassword(password);
  if (!policy.valid) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { password: policy.error },
      values,
    });
  }

  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');

  const { data, error } = await supabase.auth.signUp({
    email: parsedEmail.data,
    password,
    options: { data: { full_name: parsedName.data }, emailRedirectTo: await callbackUrl(next) },
  });
  if (error) return invalid(describeAuthError(error, 'sign-up'), { values });

  // With email confirmation on, Supabase answers an already-registered address
  // with a placeholder user carrying no identities and no session — the same
  // shape a brand-new signup gets, on purpose, so the response cannot be used to
  // test whether an address has an account. This branch therefore treats both
  // identically and no second user is ever created for one address.
  if (data.session) redirect(next);
  return { status: 'verification-sent', email: parsedEmail.data };
}

export async function forgotPasswordAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = text(formData.get('email')).trim();
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) {
    return invalid('กรุณาตรวจสอบข้อมูลที่กรอก', {
      fieldErrors: { email: 'กรุณากรอกอีเมลให้ถูกต้อง' },
      values: { email },
    });
  }

  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');

  const { error } = await supabase.auth.resetPasswordForEmail(parsedEmail.data, {
    redirectTo: await callbackUrl('/auth/reset-password'),
  });

  // Only "you are sending too many of these" comes back to the visitor. Every
  // other outcome — including an address with no account — resolves to the same
  // neutral confirmation, so this form cannot be used to discover who is
  // registered or which provider an account uses.
  if (error && (error.status === 429 || String(error.code ?? '').includes('rate_limit'))) {
    return invalid(describeAuthError(error, 'forgot-password'), { values: { email } });
  }
  return { status: 'recovery-sent', email: parsedEmail.data };
}

export async function resetPasswordAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const password = text(formData.get('password'));
  const confirmPassword = text(formData.get('confirmPassword'));

  const policy = evaluatePassword(password);
  if (!policy.valid) return invalid('กรุณาตรวจสอบรหัสผ่านใหม่', { fieldErrors: { password: policy.error } });
  if (password !== confirmPassword) {
    return invalid('กรุณาตรวจสอบรหัสผ่านใหม่', { fieldErrors: { confirmPassword: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' } });
  }

  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');

  // The same gate the reset page renders from: a real user, a session obtained
  // by following an emailed link, and an account that signs in with a password
  // in the first place. All three are read from provider-verified state — never
  // from a query parameter, and never from the address's domain.
  const context = await resolveRecoveryContext(supabase);
  if (context !== 'ready') return invalid(RECOVERY_CONTEXT_MESSAGE[context]);

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return invalid(describeAuthError(error, 'reset-password'));

  // The recovery session has done its one job. Ending it means the new password
  // has to be used at least once, and a shared or borrowed device is not left
  // signed in by a password reset.
  await supabase.auth.signOut();
  redirect('/auth/sign-in?message=' + encodeURIComponent('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบ'));
}

export async function signOutAction(): Promise<never> {
  const supabase = await createClient();
  if (supabase) await supabase.auth.signOut();
  redirect('/auth/sign-in?message=' + encodeURIComponent('ออกจากระบบแล้ว'));
}

export async function deleteAccountAction(formData: FormData): Promise<never> {
  if (formData.get('confirmation') !== 'DELETE') {
    redirect('/profile?error=' + encodeURIComponent('กรุณาพิมพ์ DELETE เพื่อยืนยัน'));
  }
  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');
  const { error } = await supabase.rpc('delete_own_account');
  if (error) redirect('/profile?error=' + encodeURIComponent('ไม่สามารถลบบัญชีได้ กรุณาลองอีกครั้ง'));
  redirect('/auth/sign-in?message=' + encodeURIComponent('ลบบัญชีเรียบร้อยแล้ว'));
}
