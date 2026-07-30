/**
 * The shape every auth server action returns to its form.
 *
 * Errors travel back as state instead of as `?error=` on a redirect, which is
 * what keeps the address the visitor typed in the field after a failed attempt
 * (React resets an uncontrolled form once its action settles, so the value has
 * to be handed back explicitly) and keeps failure messages out of browser
 * history and referrers. `values` never carries a password.
 */
export type AuthFieldName = 'fullName' | 'email' | 'password' | 'confirmPassword';

export type AuthFormStatus = 'idle' | 'error' | 'verification-sent' | 'recovery-sent';

export interface AuthFormState {
  status: AuthFormStatus;
  /** Form-level message, already localised and safe to render as text. */
  message?: string;
  fieldErrors?: Partial<Record<AuthFieldName, string>>;
  /** Non-secret values echoed back so a failed submit does not clear the form. */
  values?: { fullName?: string; email?: string };
  /** The address a verification or recovery mail was sent to, for the confirmation panel. */
  email?: string;
}

export const IDLE_AUTH_STATE: AuthFormState = { status: 'idle' };
