'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PASSWORD_RULES } from '@/src/lib/auth/password-policy';

/**
 * Every field on the auth pages is built here so the accessible wiring cannot
 * be forgotten on one form and present on another: a visible label bound by
 * `htmlFor`, `aria-invalid` while the field is rejected, `aria-describedby`
 * pointing at whichever of hint/error is rendered, and an error region that is
 * announced (`role="alert"`) rather than silently appearing.
 *
 * Inputs are controlled. React resets an uncontrolled form once its action
 * settles, which would wipe the address someone just typed the moment the
 * server said the password was wrong.
 */
interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  hint?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
}

const INPUT_BASE = 'w-full rounded-xl border bg-[var(--auth-input-bg)] text-base leading-6 text-[var(--auth-input-text)] outline-none transition-colors placeholder:text-[var(--auth-text-muted)] focus:border-[var(--auth-focus)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-focus)] disabled:opacity-60';

export function AuthField({ label, value, onValueChange, error, hint, icon, trailing, ...input }: AuthFieldProps) {
  const generatedId = useId();
  const id = input.name ? `auth-${input.name}` : generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-[var(--auth-text)]">{label}</label>
      <div className="relative">
        {icon ? (
          <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--auth-text-muted)]">
            {icon}
          </span>
        ) : null}
        <input
          {...input}
          id={id}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={INPUT_BASE}
          style={{
            minHeight: '3rem',
            paddingLeft: icon ? '2.85rem' : '0.95rem',
            paddingRight: trailing ? '3.25rem' : '0.95rem',
            borderColor: error ? 'var(--auth-danger)' : 'var(--auth-input-border)',
          }}
        />
        {trailing}
      </div>
      {hint ? <p id={hintId} className="mt-1.5 text-xs leading-5 text-[var(--auth-text-muted)]">{hint}</p> : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs leading-5 font-medium text-[var(--auth-danger)]">{error}</p>
      ) : null}
    </div>
  );
}

interface PasswordFieldProps extends Omit<AuthFieldProps, 'trailing' | 'type'> {
  /** Renders the live requirement list under the field (creation flows only). */
  showChecklist?: boolean;
}

export function PasswordField({ showChecklist = false, ...field }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="w-full">
      <AuthField
        {...field}
        type={visible ? 'text' : 'password'}
        trailing={(
          <button
            type="button"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
            aria-pressed={visible}
            className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--auth-text-muted)] transition-colors hover:text-[var(--auth-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-focus)]"
          >
            <Icon aria-hidden="true" size={18} />
          </button>
        )}
      />
      {showChecklist ? <PasswordChecklist password={field.value} /> : null}
    </div>
  );
}

/**
 * The requirement list, generated from the same `PASSWORD_RULES` the server
 * action validates against — a row can never tick green for a password the
 * server will reject.
 */
export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(password);
        return (
          <li key={rule.id} className="flex items-center gap-1.5 text-xs leading-5">
            <span
              aria-hidden="true"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold"
              style={{
                borderColor: met ? 'var(--auth-success)' : 'var(--auth-input-border)',
                background: met ? 'var(--auth-success)' : 'transparent',
                color: met ? 'var(--auth-card)' : 'transparent',
              }}
            >
              ✓
            </span>
            <span style={{ color: met ? 'var(--auth-success)' : 'var(--auth-text-muted)' }}>{rule.label}</span>
            <span className="sr-only">{met ? '— ผ่านแล้ว' : '— ยังไม่ผ่าน'}</span>
          </li>
        );
      })}
    </ul>
  );
}
