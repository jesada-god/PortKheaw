'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { AlertCircle, CheckCircle2, Loader2, MailCheck } from 'lucide-react';

/**
 * Submit button for a server-action form.
 *
 * `useFormStatus` is the whole double-submit story: while the action is in
 * flight the button is genuinely `disabled`, so a second click, a double tap,
 * or Enter held down cannot start a second sign-in or send a second
 * confirmation mail. It reports its own busy state with `aria-busy` rather than
 * only a spinner.
 */
export function AuthSubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-focus)] disabled:cursor-not-allowed disabled:opacity-70"
      style={{ background: 'var(--auth-primary)', color: 'var(--auth-primary-fg)' }}
    >
      {pending ? <Loader2 aria-hidden="true" size={18} className="motion-safe:animate-spin" /> : null}
      {pending ? pendingLabel : children}
    </button>
  );
}

/** Form-level banner. Text only — provider payloads never reach this component. */
export function AuthBanner({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  const isError = Boolean(error);
  const Icon = isError ? AlertCircle : CheckCircle2;
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className="mb-4 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm leading-6"
      style={{
        background: isError ? 'var(--auth-danger-surface)' : 'var(--auth-info-surface)',
        color: isError ? 'var(--auth-danger)' : 'var(--auth-success)',
        border: `1px solid ${isError ? 'var(--auth-danger)' : 'var(--auth-success)'}`,
      }}
    >
      <Icon aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
      <span>{error ?? message}</span>
    </div>
  );
}

export function AuthDivider({ label = 'หรือ' }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1" style={{ background: 'var(--auth-card-border)' }} />
      <span className="text-xs" style={{ color: 'var(--auth-text-muted)' }}>{label}</span>
      <span className="h-px flex-1" style={{ background: 'var(--auth-card-border)' }} />
    </div>
  );
}

/**
 * Shown after sign-up or after a recovery request. The wording is identical
 * whether or not the address has an account — the server cannot tell the
 * difference apart, and neither can this screen.
 */
export function AuthMailSentPanel({
  title,
  email,
  description,
  headingLevel = 'h2',
  children,
}: {
  title: string;
  email?: string;
  description: string;
  /** `h1` when this panel *is* the page; `h2` when it sits under the page's own title. */
  headingLevel?: 'h1' | 'h2';
  children?: React.ReactNode;
}) {
  const Heading = headingLevel;
  return (
    <div role="status" className="text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
        style={{ background: 'var(--auth-info-surface)', color: 'var(--auth-success)' }}
      >
        <MailCheck size={26} />
      </span>
      <Heading className="text-lg font-bold" style={{ color: 'var(--auth-text)' }}>{title}</Heading>
      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--auth-text-secondary)' }}>{description}</p>
      {email ? (
        <p className="mt-3 break-all rounded-xl px-3 py-2 text-sm font-medium" style={{ background: 'var(--auth-card-soft)', color: 'var(--auth-text)' }}>
          {email}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Client-side send throttle for "send it again".
 *
 * Supabase applies its own server-side limit and answers a burst with a rate
 * limit error; this only stops the visitor walking into that error by making
 * the button unavailable until the cooldown elapses.
 */
export function ResendCooldown({ seconds = 60, children }: { seconds?: number; children: React.ReactNode }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  if (remaining > 0) {
    return (
      <p className="mt-4 text-xs" style={{ color: 'var(--auth-text-muted)' }} aria-live="polite">
        ส่งอีกครั้งได้ใน {remaining} วินาที
      </p>
    );
  }
  return <div className="mt-4">{children}</div>;
}

/** Text link styled for the ivory card. */
export function AuthLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-1 text-sm font-semibold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-focus)] ${className ?? ''}`}
      style={{ color: 'var(--auth-primary)' }}
    >
      {children}
    </Link>
  );
}
