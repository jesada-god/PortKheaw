import { resolveEffectiveTier } from './resolve-effective-tier';
import type { SubscriptionSnapshot, SubscriptionTier } from './subscription-types';

/** Every failure `start_elite_trial()` can raise, named exactly as the database names it. */
export const trialErrorCodes = [
  'TRIAL_ALREADY_USED',
  'TRIAL_ALREADY_ACTIVE',
  'PAID_SUBSCRIPTION_ACTIVE',
  'EMAIL_NOT_VERIFIED',
  'SUBSCRIPTION_NOT_FOUND',
] as const;
export type TrialErrorCode = typeof trialErrorCodes[number];

export type TrialFailureCode = TrialErrorCode | 'UNAUTHENTICATED' | 'UNAVAILABLE';

export const TRIAL_DURATION_DAYS = 7;

/**
 * What the Current Plan hero is looking at. Derived only from the server
 * snapshot and the database clock inside it — never from the browser's clock,
 * and never from a value the client could have chosen.
 */
export type TrialState =
  | { kind: 'eligible' }
  | { kind: 'email-unverified' }
  | { kind: 'trialing'; endsAt: string; remainingMs: number }
  | { kind: 'used' }
  | { kind: 'paid'; tier: SubscriptionTier };

export function resolveTrialState(
  snapshot: SubscriptionSnapshot | null,
  emailVerified: boolean,
): TrialState {
  if (!snapshot) return { kind: 'eligible' };
  const now = Date.parse(snapshot.databaseNow);
  const effectiveTier = resolveEffectiveTier(snapshot, snapshot.databaseNow);

  // A paid plan outranks everything: it is the reason the trial is unavailable.
  if (snapshot.status === 'active' && (effectiveTier === 'pro' || effectiveTier === 'elite')) {
    return { kind: 'paid', tier: effectiveTier };
  }

  const endsAt = snapshot.trialEndsAt ? Date.parse(snapshot.trialEndsAt) : Number.NaN;
  if (
    snapshot.status === 'trialing'
    && Number.isFinite(endsAt)
    && Number.isFinite(now)
    && endsAt > now
  ) {
    return { kind: 'trialing', endsAt: snapshot.trialEndsAt!, remainingMs: endsAt - now };
  }

  if (snapshot.trialUsedAt !== null) return { kind: 'used' };
  if (!emailVerified) return { kind: 'email-unverified' };
  return { kind: 'eligible' };
}

/** Only one state offers the button, so the page never renders two trial CTAs. */
export function canStartTrial(state: TrialState): boolean {
  return state.kind === 'eligible';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "6 วัน 3 ชั่วโมง" — coarse on purpose. A trial measured to the second invites
 * a per-second re-render and tells the reader nothing they can act on.
 */
export function formatTrialRemaining(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'หมดอายุแล้ว';
  const days = Math.floor(remainingMs / DAY);
  const hours = Math.floor((remainingMs % DAY) / HOUR);
  const minutes = Math.floor((remainingMs % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days} วัน ${hours} ชั่วโมง` : `${days} วัน`;
  if (hours > 0) return minutes > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${hours} ชั่วโมง`;
  if (minutes > 0) return `${minutes} นาที`;
  return 'ไม่ถึง 1 นาที';
}

/**
 * A fixed Bangkok-time expiry label. Built from the UTC parts by hand rather
 * than through `toLocaleString`, because the server and the reader's device sit
 * in different time zones and any locale-dependent formatting of the same
 * instant is a hydration mismatch waiting to happen.
 */
const THAI_MONTHS = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
] as const;
const BANGKOK_OFFSET_MS = 7 * HOUR;

export function formatBangkokDateTime(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return '—';
  const local = new Date(parsed + BANGKOK_OFFSET_MS);
  const day = local.getUTCDate();
  const month = THAI_MONTHS[local.getUTCMonth()];
  const year = local.getUTCFullYear() + 543;
  const hour = local.getUTCHours().toString().padStart(2, '0');
  const minute = local.getUTCMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${year} เวลา ${hour}:${minute} น.`;
}

const TRIAL_FAILURE_MESSAGES: Record<TrialFailureCode, string> = {
  TRIAL_ALREADY_USED: 'บัญชีนี้เคยใช้สิทธิ์ทดลอง Elite ไปแล้ว จึงใช้ซ้ำไม่ได้',
  TRIAL_ALREADY_ACTIVE: 'คุณกำลังอยู่ในช่วงทดลอง Elite อยู่แล้ว',
  PAID_SUBSCRIPTION_ACTIVE: 'บัญชีนี้มีแพ็กเกจแบบชำระเงินที่ยังใช้งานอยู่ จึงไม่ต้องใช้สิทธิ์ทดลอง',
  EMAIL_NOT_VERIFIED: 'กรุณายืนยันอีเมลของคุณก่อน แล้วจึงเริ่มทดลอง Elite ได้',
  SUBSCRIPTION_NOT_FOUND: 'ไม่พบข้อมูลแพ็กเกจของบัญชีนี้ กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบอีกครั้งก่อนเริ่มทดลอง',
  UNAVAILABLE: 'เริ่มทดลองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
};

export function trialFailureMessage(code: TrialFailureCode): string {
  return TRIAL_FAILURE_MESSAGES[code] ?? TRIAL_FAILURE_MESSAGES.UNAVAILABLE;
}

/**
 * Maps a PostgREST error onto a typed code. The database raises the code as the
 * exception message, so the match is on that text and nothing else — an
 * unrecognised failure stays `UNAVAILABLE` rather than being guessed at.
 */
export function trialFailureCode(error: unknown): TrialFailureCode {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return 'UNAVAILABLE';
  const matched = trialErrorCodes.find((code) => message.includes(code));
  return matched ?? 'UNAVAILABLE';
}
