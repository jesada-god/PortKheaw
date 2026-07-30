import { hasPasswordIdentity, hasRecoveryAssurance } from './identity';

/**
 * Decides, from provider-verified state alone, whether a new password may be
 * set right now. The reset page renders from this and the reset action gates on
 * it, so the screen a visitor sees and the answer the server gives can never
 * disagree — a page that shows the form while the action always refuses is
 * worse than no page at all.
 */
export type RecoveryContext =
  /** A live recovery session on an account that signs in with a password. */
  | 'ready'
  /** Nothing to work with: the link was never followed, or the session is gone. */
  | 'no-session'
  /** A session exists, but it was not obtained by following an emailed link. */
  | 'not-recovery'
  /** The mailbox is proven, but this account has no password to reset. */
  | 'oauth-only';

interface RecoveryCapableClient {
  auth: {
    getUser: () => Promise<{ data: { user: unknown | null } }>;
    getClaims: () => Promise<{ data: { claims?: unknown } | null }>;
  };
}

export async function resolveRecoveryContext(client: RecoveryCapableClient): Promise<RecoveryContext> {
  const [userResult, claimsResult] = await Promise.all([
    client.auth.getUser(),
    client.auth.getClaims(),
  ]);

  const user = userResult?.data?.user ?? null;
  if (!user) return 'no-session';
  if (!hasRecoveryAssurance((claimsResult?.data as { claims?: { amr?: unknown } } | null)?.claims)) return 'not-recovery';
  if (!hasPasswordIdentity(user as { identities?: { provider?: unknown }[] | null })) return 'oauth-only';
  return 'ready';
}

/** The message shown for every context that is not `ready`. */
export const RECOVERY_CONTEXT_MESSAGE: Record<Exclude<RecoveryContext, 'ready'>, string> = {
  'no-session': 'ลิงก์ตั้งรหัสผ่านหมดอายุแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง',
  'not-recovery': 'ลิงก์ตั้งรหัสผ่านหมดอายุแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง',
  'oauth-only': 'บัญชีนี้เข้าสู่ระบบด้วยผู้ให้บริการภายนอก จึงตั้งรหัสผ่านไม่ได้',
};
