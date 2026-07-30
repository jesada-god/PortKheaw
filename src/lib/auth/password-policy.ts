/**
 * The one definition of "is this password acceptable".
 *
 * The visible checklist on the sign-up and reset-password forms and the schema
 * the server action validates against are both generated from {@link PASSWORD_RULES}.
 * They cannot drift: a checklist that ticks green while the server rejects the
 * password is a bug that only shows up as an unexplained failure at submit time.
 *
 * The upper bound is not cosmetic. Supabase hashes with bcrypt, which silently
 * ignores everything past 72 *bytes* — a Thai password can reach that in ~24
 * characters — so a longer password is refused with a clear message instead of
 * being quietly truncated to something the user did not choose.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72;

export interface PasswordRule {
  id: 'length' | 'uppercase' | 'digit' | 'symbol';
  /** Shown in the live checklist, phrased as the requirement being met. */
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'length',
    label: `อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`,
    test: (password) => password.length >= MIN_PASSWORD_LENGTH,
  },
  {
    id: 'uppercase',
    label: 'มีตัวพิมพ์ใหญ่ (A-Z)',
    test: (password) => /[A-Z]/.test(password),
  },
  {
    id: 'digit',
    label: 'มีตัวเลข (0-9)',
    test: (password) => /[0-9]/.test(password),
  },
  {
    id: 'symbol',
    label: 'มีอักขระพิเศษ เช่น ! @ # $',
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

const encoder = new TextEncoder();

export function passwordByteLength(password: string): number {
  return encoder.encode(password).length;
}

export interface PasswordEvaluation {
  /** Rule ids the password currently satisfies. */
  satisfied: PasswordRule['id'][];
  /** True only when every rule passes and the password fits bcrypt's input. */
  valid: boolean;
  /** Set when the password is unusable for a reason no checklist row covers. */
  error?: string;
}

/**
 * Evaluates a password without altering it. Passwords are never trimmed,
 * normalised or case-folded anywhere in this codebase — a leading space the
 * user (or their password manager) intended is part of the secret.
 */
export function evaluatePassword(password: string): PasswordEvaluation {
  const satisfied = PASSWORD_RULES.filter((rule) => rule.test(password)).map((rule) => rule.id);
  if (satisfied.length < PASSWORD_RULES.length) {
    return { satisfied, valid: false, error: 'รหัสผ่านยังไม่ครบเงื่อนไขด้านล่าง' };
  }
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    return { satisfied, valid: false, error: 'รหัสผ่านยาวเกินไป กรุณาใช้ให้สั้นลง' };
  }
  return { satisfied, valid: true };
}
