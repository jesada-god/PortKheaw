import { redirect } from 'next/navigation';
import { User, Settings, ChevronRight, Shield, BellRing, CreditCard } from 'lucide-react';
import Link from 'next/link';
import Header from '@/src/components/layout/Header';
import { AuthMessage } from '@/src/components/auth/AuthMessage';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { AccountActions } from '@/src/components/auth/AccountActions';
import { AccountIdentity } from '@/src/components/subscription/AccountBadges';
import { AccountPlanSummary } from '@/src/components/subscription/AccountPlanSummary';
import { AdminPreviewSelector } from '@/src/components/subscription/AdminPreviewSelector';
import { createClient } from '@/src/lib/supabase/server';
import { reauthMethodFor, signInIsFresh } from '@/src/lib/account/reauthentication';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { resolveAccountBadges } from '@/src/lib/subscription/account-badges';
import { resolveAccountPlanSummary } from '@/src/lib/subscription/account-plan-summary';
import { formatBangkokDateTime } from '@/src/lib/subscription/trial';

/*
 * Role, plan and any running preview are per-reader and decided from the
 * database clock, so this page is never prerendered into shared HTML.
 */
export const dynamic = 'force-dynamic';

export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const supabase = await createClient();
  if (!supabase) return <><Header title="โปรไฟล์" /><div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div></>;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/profile');
  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const metadataName = typeof user.user_metadata.full_name === 'string' ? user.user_metadata.full_name : null;
  const fullName = profile?.full_name || metadataName || user.email?.split('@')[0] || 'PortKheaw User';
  const error = typeof params.error === 'string' ? params.error : undefined;

  const access = await resolveRequestAccountAccess();
  /*
   * Both of these read `subscriptionEffectiveTier`, which is the plan the
   * account actually holds and is never rewritten by the operator role or by a
   * running preview. That is what lets the badge row and the plan line below it
   * disagree with `effectiveAccessTier` without either of them being wrong.
   */
  const badgeInput = {
    role: access.role,
    adminPreviewMode: access.adminPreviewMode,
    subscriptionEffectiveTier: access.subscriptionEffectiveTier,
    status: access.status,
  };
  const badges = resolveAccountBadges(badgeInput);
  const planSummary = resolveAccountPlanSummary(badgeInput);
  const previewing = access.adminPreviewMode !== 'actual';

  return (
    <div>
      <Header title="โปรไฟล์" />
      <div className="mx-auto min-w-0 max-w-2xl space-y-6 p-4 md:p-8">
        <AuthMessage error={error} />

        <div className="flex min-w-0 items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:gap-6 sm:p-6">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-[var(--accent)] bg-[var(--surface-hover)] text-[var(--text-muted)] sm:h-20 sm:w-20">
            <User size={36} />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <AccountIdentity name={fullName} badges={badges} />
            <p className="truncate text-sm text-[var(--text-secondary)]">{user.email}</p>
          </div>
        </div>

        <section
          aria-labelledby="plan-summary-heading"
          className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:p-6"
        >
          {/* The heading names the section; the plan and the access grant are
              each labelled inside it, so neither can be read as the other. */}
          <h2 id="plan-summary-heading" className="sr-only">แพ็กเกจและสิทธิ์ของคุณ</h2>
          <AccountPlanSummary summary={planSummary} />

          {previewing && access.previewExpiresAt && (
            <p
              data-testid="profile-preview-note"
              className="mt-2 text-xs leading-5 text-[var(--text-muted)]"
            >
              หมดอายุ {formatBangkokDateTime(access.previewExpiresAt)}
            </p>
          )}

          <Link
            href="/settings/subscription"
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--text)] motion-safe:transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            <CreditCard aria-hidden="true" size={16} className="text-[var(--text-muted)]" />
            จัดการแพ็กเกจ
          </Link>
        </section>

        {access.isAdmin && (
          <AdminPreviewSelector
            currentMode={access.adminPreviewMode}
            expiresAt={access.previewExpiresAt}
          />
        )}

        <div className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]">
          <Link href="/settings" className="flex min-h-14 items-center justify-between border-b border-[var(--border)] p-4 motion-safe:transition-colors hover:bg-[var(--surface-hover)]"><span className="flex items-center gap-3 text-[var(--text-secondary)]"><Settings size={20} className="text-[var(--text-muted)]" />การตั้งค่าแอป</span><ChevronRight size={16} className="text-[var(--text-muted)]" /></Link>
          <Link href="/alerts" className="flex min-h-14 items-center justify-between border-b border-[var(--border)] p-4 motion-safe:transition-colors hover:bg-[var(--surface-hover)]"><span className="flex items-center gap-3 text-[var(--text-secondary)]"><BellRing size={20} className="text-[var(--text-muted)]" />การแจ้งเตือนราคา</span><ChevronRight size={16} className="text-[var(--text-muted)]" /></Link>
          {/* The old "Authenticated" chip said the same thing as this row and
              competed with the plan badge for the same spot beside the name, so
              it is now only this quieter, secondary statement. */}
          <div className="flex min-h-14 items-center gap-3 p-4 text-[var(--text-secondary)]"><Shield size={20} className="text-[var(--text-muted)]" /><span>บัญชีได้รับการป้องกันด้วย Supabase Auth</span></div>
        </div>
        {/*
          * How this account can prove itself is read from its provider
          * identities on the server, never guessed from the address. The dialog
          * only renders the right fields; the action checks all of it again.
          */}
        <AccountActions
          reauthMethod={reauthMethodFor(user)}
          signInFresh={signInIsFresh(user.last_sign_in_at)}
        />
      </div>
    </div>
  );
}
