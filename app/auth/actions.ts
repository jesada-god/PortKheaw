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
import {
  consumeLayeredRateLimit, rateLimitMessage, resolveClientAddress,
  type RateLimitScope,
} from '@/src/lib/security/rate-limit';
import { deleteAccount } from '@/src/lib/account/account-deletion';
import { assertMutationAllowed } from '@/src/lib/security/lockdown-server';
import { reauthMethodFor, signInIsFresh, verifyPassword } from '@/src/lib/account/reauthentication';
import {
  DELETE_ACCOUNT_CONFIRMATION,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  deleteAccountMessage,
  type DeleteAccountFailure,
  type DeleteAccountState,
} from '@/src/lib/account/deletion-copy';

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

/**
 * Bound one attempt at an entry form, before the provider hears about it.
 *
 * Two identities are charged, and they see different attacks. The **address**
 * catches one machine working through a password list. The **attempted email**
 * catches the opposite shape — a botnet with a thousand addresses all trying the
 * same account — which an address-keyed limiter is blind to by construction.
 * Neither is an account: at a sign-in form there is no account yet, which is
 * exactly why this is the surface worth bounding.
 *
 * It runs *before* `signInWithPassword`, `signUp` and `resetPasswordForEmail`,
 * so a refused attempt costs one round trip to our own database instead of a
 * credential check, a mailbox, or a Supabase project quota that everybody else
 * on this instance shares.
 *
 * The refusal is the same neutral sentence for every scope and never names the
 * bound, the remaining budget, or which of the two identities ran out — a
 * limiter that reports which key it counted is a limiter that tells an attacker
 * which key to rotate.
 */
async function boundAuthAttempt(
  supabase: Awaited<ReturnType<typeof createClient>>,
  scope: RateLimitScope,
  subject: string | null,
): Promise<string | null> {
  const limit = await consumeLayeredRateLimit(supabase, {
    scope,
    clientAddress: await resolveClientAddress(),
    subject,
  });
  return limit.allowed ? null : rateLimitMessage(limit.retryAfterSeconds);
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

  const bounded = await boundAuthAttempt(supabase, 'auth.sign-in', parsedEmail.data);
  if (bounded) return invalid(bounded, { values: { email } });

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

  const bounded = await boundAuthAttempt(supabase, 'auth.sign-up', parsedEmail.data);
  if (bounded) return invalid(bounded, { values });

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

  /*
   * Bounded before the mail is asked for, not after. Each of these sends a real
   * message to a real inbox: an unbounded form is a way to use this product to
   * flood somebody else's mailbox, and the person being mailed is not the person
   * being refused here.
   */
  const bounded = await boundAuthAttempt(supabase, 'auth.password-reset', parsedEmail.data);
  if (bounded) return invalid(bounded, { values: { email } });

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

  const bounded = await boundAuthAttempt(supabase, 'auth.password-update', null);
  if (bounded) return invalid(bounded);

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

/**
 * Delete this account, for real.
 *
 * Three things have to be true before anything happens, and all three are
 * decided here rather than in the dialog:
 *
 *   1. the confirmation phrase was typed exactly;
 *   2. the person proved who they are *now* — a password re-entered, or a Google
 *      sign-in from the last few minutes — because a session cookie is not that
 *      proof and this is irreversible;
 *   3. the account is the caller's own. There is no account argument, so there
 *      is nothing to tamper with: the subject comes from the verified session
 *      and from nowhere else.
 *
 * The work itself is a staged pipeline that keeps the spent trial, settles the
 * payment provider, empties the storage bucket and removes the account's data
 * *before* it removes the auth user. Failures come back as a sentence; nothing
 * here ever puts a provider error, a stack or an identifier in front of a
 * reader.
 */
export async function deleteAccountAction(
  _prevState: DeleteAccountState,
  formData: FormData,
): Promise<DeleteAccountState | never> {
  const fail = (failure: DeleteAccountFailure, field?: DeleteAccountState['field']): DeleteAccountState => ({
    status: 'error',
    message: deleteAccountMessage(failure),
    ...(field ? { field } : {}),
  });

  if (text(formData.get('confirmation')).trim() !== DELETE_ACCOUNT_CONFIRMATION) {
    return fail('not-confirmed', 'confirmation');
  }

  const supabase = await createClient();
  if (!supabase) redirect('/auth/configuration-required');

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return fail('unauthenticated');

  if (reauthMethodFor(user) === 'password') {
    const password = text(formData.get('password'));
    if (!password) return fail('password-required', 'password');
    if (!user.email) return fail('reauth-unavailable');
    const outcome = await verifyPassword(user.email, password);
    if (outcome === 'unavailable') return fail('reauth-unavailable');
    if (outcome !== 'verified') return fail('password-rejected', 'password');
  } else if (!signInIsFresh(user.last_sign_in_at)) {
    return fail('reauth-stale');
  }

  /*
   * The incident switch, checked last — after the reader has proved who they are.
   *
   * Deletion runs on the service-role client, which means it is one of the few
   * paths in this product that row-level security does not bound: it removes
   * data across every table and then the auth user itself, and none of it comes
   * back. That is exactly the class of write a lockdown exists to hold, and this
   * is the only gate in front of it.
   *
   * After re-authentication rather than before, so a caller who cannot prove
   * they are the account holder learns nothing about the platform's state.
   */
  try {
    await assertMutationAllowed('account-destructive');
  } catch {
    return fail('locked-down');
  }

  const result = await deleteAccount(user.id);
  if (!result.ok) {
    return fail(result.reason === 'provider-failed' ? 'provider-failed' : 'unavailable');
  }

  // The account is gone; the cookie that pointed at it must go with it, or the
  // next request arrives with a token for a user that no longer exists.
  await supabase.auth.signOut().catch(() => undefined);
  redirect('/auth/sign-in?message=' + encodeURIComponent(DELETE_ACCOUNT_SUCCESS_MESSAGE));
}
