import Link from 'next/link';
import { appConfig } from '@/src/config/app';
import { cn } from '@/src/utils/cn';
import { AuthBackdrop } from './AuthBackdrop';

export const AUTH_TAGLINE = 'พอร์ตเขียว เริ่มจากเข้าใจพอร์ตของคุณ';

/**
 * The PortKheaw wordmark. `Kheaw` carries the brand green in both placements;
 * on the green field the first half turns white so the lockup keeps its
 * two-tone reading instead of disappearing into the background.
 */
export function AuthWordmark({ tone = 'on-field', className }: { tone?: 'on-field' | 'on-card'; className?: string }) {
  return (
    <span className={cn('inline-flex items-start font-extrabold tracking-tight', className)}>
      <span style={{ color: tone === 'on-field' ? 'var(--auth-on-field)' : 'var(--auth-text)' }}>Port</span>
      <span style={{ color: tone === 'on-field' ? 'var(--auth-decor)' : 'var(--auth-primary)' }}>Kheaw</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="ml-0.5 h-[0.55em] w-[0.55em] shrink-0"
        fill="none"
        stroke={tone === 'on-field' ? 'var(--auth-decor)' : 'var(--auth-primary)'}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 18 L10 10 L14 14 L21 5" />
        <path d="M15 5 L21 5 L21 11" />
      </svg>
    </span>
  );
}

/**
 * Full-bleed green field shared by every authentication page.
 *
 * The page owns the viewport here — no sidebar, no bottom navigation — and the
 * layout is a scrolling column rather than a fixed centred box, so that when a
 * mobile keyboard halves the visible height the submit button is still
 * reachable by scrolling instead of being pinned off-screen. Safe-area insets
 * are honoured on all four sides for notched iOS devices.
 */
export function AuthShell({ children, width = 'form' }: { children: React.ReactNode; width?: 'form' | 'wide' }) {
  return (
    <div
      data-auth-shell
      className="relative flex min-h-dvh w-full max-w-full flex-col overflow-x-hidden"
      style={{ backgroundColor: 'var(--auth-field-top)' }}
    >
      <AuthBackdrop />
      <div
        className="relative flex min-h-dvh flex-1 flex-col items-center justify-center px-4 sm:px-6"
        style={{
          paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
          paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
        }}
      >
        <div className={cn('w-full', width === 'wide' ? 'max-w-lg' : 'max-w-[26rem]')}>{children}</div>
      </div>
    </div>
  );
}

/** Logo lockup shown above the card on every auth page. */
export function AuthHeader({ compact = false }: { compact?: boolean }) {
  return (
    <div className="mb-5 text-center">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center justify-center rounded-xl px-2"
        aria-label={`${appConfig.name} หน้าแรก`}
      >
        <AuthWordmark className={compact ? 'text-[1.75rem]' : 'text-[2.1rem] sm:text-[2.4rem]'} />
      </Link>
      <p className="mt-1 text-sm" style={{ color: 'var(--auth-on-field-muted)' }}>{AUTH_TAGLINE}</p>
    </div>
  );
}

/** The ivory (light) / deep (dark) card the forms live in. */
export function AuthCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      data-auth-rise
      className={cn('w-full p-5 sm:p-7', className)}
      style={{
        background: 'var(--auth-card)',
        border: '1px solid var(--auth-card-border)',
        borderRadius: 'var(--auth-card-radius)',
        boxShadow: 'var(--auth-card-shadow)',
        color: 'var(--auth-text)',
      }}
    >
      {children}
    </section>
  );
}

export function AuthTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[1.55rem] font-bold leading-tight" style={{ color: 'var(--auth-text)' }}>{title}</h1>
      {description ? (
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--auth-text-secondary)' }}>{description}</p>
      ) : null}
    </div>
  );
}
