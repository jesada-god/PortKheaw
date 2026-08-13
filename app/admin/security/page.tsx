import Header from '@/src/components/layout/Header';
import { AdminSecurityControl } from '@/src/components/admin/AdminSecurityControl';
import { SecurityLockdownControl } from '@/src/components/admin/SecurityLockdownControl';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';
import { isAdminConsolePath } from '@/src/lib/auth/paths';
import { resolveAdminAssurance } from '@/src/lib/security/admin-assurance-server';
import { createClient } from '@/src/lib/supabase/server';

/**
 * The one page under `/admin` that an operator can open without having presented
 * a second factor — because it is where the factor is presented.
 *
 * It is not an exemption from the operator check. `requireAdminPage()` runs on
 * the first line exactly as it does on every other console page, and a
 * non-operator gets the same bare 404 here that they get anywhere else under
 * `/admin`. What is relaxed is only the assurance requirement, and only for the
 * page that exists to satisfy it.
 *
 * The state is resolved on the server so the first paint is already correct: an
 * operator with no factor sees an enrolment prompt, one with a factor sees a
 * code field, and one who is already at `aal2` sees their devices and the offer
 * to add a backup. The browser re-reads the same facts from Supabase on mount,
 * so a stale render cannot be what decides anything.
 */
export const dynamic = 'force-dynamic';

/**
 * Where the operator is sent once the requirement is met.
 *
 * Restricted to console paths. The value arrives in a query parameter, which
 * makes it attacker-controlled, and a redirect target that accepts anything is
 * an open redirect wearing a security page's clothes.
 */
function safeConsoleReturn(value: string | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/admin';
  if (value.includes('\\')) return '/admin';
  const path = value.split('?')[0];
  return isAdminConsolePath(path) ? path : '/admin';
}

export default async function AdminSecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The operator check, exactly as every console page runs it — but not the
  // assurance check, which this page exists to let them satisfy.
  await requireAdminPage({ assurance: 'exempt' });
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const assurance = await resolveAdminAssurance();
  const lockdown = await readLockdownState();

  return (
    <>
      <Header title="ความปลอดภัยผู้ดูแลระบบ" subtitle="ยืนยันตัวตนสองชั้น" backFallbackHref="/admin" />
      <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 pb-24">
        <AdminSecurityControl
          requirement={assurance.satisfied ? 'satisfied' : assurance.requirement === 'verify' ? 'verify' : 'enroll'}
          returnTo={safeConsoleReturn(next)}
        />
        {/*
          * The incident switch lives on this page and nowhere else, for the same
          * reason this page is exempt from the assurance redirect: it is the one
          * console surface that stays reachable while the lockdown is engaged.
          * Putting it on `/admin/system` beside maintenance would mean engaging
          * it locks the operator out of the control that releases it.
          */}
        <SecurityLockdownControl
          enabled={lockdown.enabled}
          reason={lockdown.reason}
          startedAt={lockdown.startedAt}
          assured={assurance.satisfied}
        />
      </main>
    </>
  );
}

interface LockdownState {
  enabled: boolean;
  reason: string | null;
  startedAt: string | null;
}

const LOCKDOWN_UNKNOWN: LockdownState = { enabled: false, reason: null, startedAt: null };

/**
 * The operator's view of the switch.
 *
 * Reads through `admin_security_posture`, which checks the operator role inside
 * the database and refuses on its own terms — so this render cannot show the
 * incident state to somebody the database does not call an operator, even if
 * every layer above it were wrong.
 *
 * An unreadable switch renders as "not locked down". That is the honest answer
 * for a *display*: it grants nothing, the control still posts to an action that
 * resolves the real state server-side, and the alternative — rendering a
 * lockdown that is not in effect — would send an operator hunting for an
 * incident that is not happening.
 */
async function readLockdownState(): Promise<LockdownState> {
  try {
    const client = await createClient();
    if (!client) return LOCKDOWN_UNKNOWN;
    const { data, error } = await client.rpc('admin_security_posture');
    if (error) throw error;
    const row = data?.[0];
    if (!row) return LOCKDOWN_UNKNOWN;
    return {
      enabled: row.security_lockdown_enabled === true,
      reason: row.security_lockdown_reason,
      startedAt: row.security_lockdown_started_at,
    };
  } catch {
    return LOCKDOWN_UNKNOWN;
  }
}
