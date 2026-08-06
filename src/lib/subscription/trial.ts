import { BETA_ACCESS_UNAVAILABLE_MESSAGE } from '@/src/lib/beta/beta-stages';
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

export type TrialFailureCode =
  | TrialErrorCode
  | 'UNAUTHENTICATED'
  /** The controlled rollout has not admitted this account yet. */
  | 'BETA_NOT_ADMITTED'
  /** The rollout could not be read, so no grant is made. Retryable. */
  | 'BETA_ACCESS_UNAVAILABLE'
  /**
   * The persistent ledger already holds one of this account's identities. Told
   * apart from `TRIAL_ALREADY_USED` on purpose: that one is a fact about *this*
   * account's own row, and this one is a fact that outlived a deleted account —
   * the reader is very likely seeing it on an account that is minutes old, and
   * the sentence has to make sense in that situation.
   */
  | 'TRIAL_IDENTITY_ALREADY_USED'
  /**
   * The ledger could not be read or written. Refused rather than waved through:
   * a trial nobody can record is exactly the defect the ledger exists to close.
   * Retryable.
   */
  | 'TRIAL_IDENTITY_UNAVAILABLE'
  /** The account is being deleted, so it starts nothing new. */
  | 'ACCOUNT_DELETING'
  | 'UNAVAILABLE';

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

/**
 * The subset of a snapshot the trial rule actually reads. Naming it lets the
 * trusted account resolver — which never carries billing identifiers — answer
 * the same question from the same code as the subscription centre.
 */
export type TrialSnapshot = Pick<
  SubscriptionSnapshot,
  'tier' | 'status' | 'trialEndsAt' | 'trialUsedAt' | 'currentPeriodEnd' | 'databaseNow'
>;

export function resolveTrialState(
  snapshot: TrialSnapshot | null,
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

/** Whether the one free Elite trial is running, spent, or still on the table. */
export type TrialOffer = 'available' | 'active' | 'used';

/**
 * Which trial call to action a paywall should offer.
 *
 * Mailbox confirmation is deliberately passed as `true` here: it gates *starting*
 * a trial, not whether one is still on offer, and both of its outcomes
 * (`eligible`, `email-unverified`) mean the same thing to an upgrade prompt.
 * Deriving the offer from the one trial rule keeps it from drifting.
 */
export function resolveTrialOffer(snapshot: TrialSnapshot | null): TrialOffer {
  const state = resolveTrialState(snapshot, true);
  if (state.kind === 'trialing') return 'active';
  if (state.kind === 'used' || state.kind === 'paid') return 'used';
  return 'available';
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

/**
 * Why the trial is closed to a reader the controlled rollout has not admitted.
 *
 * The trial is a grant of the top plan, so it is a way *in* to the product just
 * as a purchase is, and the same stage decides both. It sits here beside the
 * rest of the trial copy for the same reason the administrator sentence below
 * does: a `'use server'` module may only export functions, and this sentence is
 * shown on the disabled control as well as returned by the refused action.
 *
 * Deliberately says nothing about who is admitted or when. Whether an account is
 * grandfathered, invited or already a subscriber is not something a refusal
 * should let anybody infer, and the waitlist card below the hero is where the
 * fuller explanation already lives.
 */
export const TRIAL_BETA_BLOCKED_MESSAGE = 'ขณะนี้เปิดให้ทดลองเฉพาะผู้ได้รับสิทธิ์เบต้า';

/**
 * What somebody is told when the persistent ledger has already seen them.
 *
 * The reader is almost always looking at a brand-new account, so "this account
 * has used it" would read as a bug. The sentence therefore states the rule and
 * the way forward together, and it is the same sentence wherever the refusal
 * surfaces — the hero, the action's answer, and the paywall.
 */
export const TRIAL_IDENTITY_USED_MESSAGE =
  'บัญชีนี้เคยใช้สิทธิทดลองฟรีแล้ว สามารถเลือกแพ็กเกจเพื่อใช้งานต่อได้';

const TRIAL_FAILURE_MESSAGES: Record<TrialFailureCode, string> = {
  TRIAL_ALREADY_USED: 'บัญชีนี้เคยใช้สิทธิ์ทดลอง Elite ไปแล้ว จึงใช้ซ้ำไม่ได้',
  TRIAL_ALREADY_ACTIVE: 'คุณกำลังอยู่ในช่วงทดลอง Elite อยู่แล้ว',
  PAID_SUBSCRIPTION_ACTIVE: 'บัญชีนี้มีแพ็กเกจแบบชำระเงินที่ยังใช้งานอยู่ จึงไม่ต้องใช้สิทธิ์ทดลอง',
  EMAIL_NOT_VERIFIED: 'กรุณายืนยันอีเมลของคุณก่อน แล้วจึงเริ่มทดลอง Elite ได้',
  SUBSCRIPTION_NOT_FOUND: 'ไม่พบข้อมูลแพ็กเกจของบัญชีนี้ กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบอีกครั้งก่อนเริ่มทดลอง',
  BETA_NOT_ADMITTED: TRIAL_BETA_BLOCKED_MESSAGE,
  /*
   * Not a refusal by the rollout — the rollout said nothing. The trial and the
   * checkout share one sentence for it, so a reader who tries both is not told
   * two different stories about one outage.
   */
  BETA_ACCESS_UNAVAILABLE: BETA_ACCESS_UNAVAILABLE_MESSAGE,
  /*
   * Says what is true and offers the way forward in the same breath. It
   * deliberately does not say *which* earlier account, when, or on which
   * address: the reader knows, and anybody else reading over their shoulder
   * would be learning something about a mailbox from a page that has no
   * business teaching it.
   */
  TRIAL_IDENTITY_ALREADY_USED: TRIAL_IDENTITY_USED_MESSAGE,
  TRIAL_IDENTITY_UNAVAILABLE: 'ขณะนี้ยังเริ่มทดลองไม่ได้ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
  ACCOUNT_DELETING: 'บัญชีนี้กำลังอยู่ระหว่างการลบ จึงเริ่มรายการใหม่ไม่ได้',
  UNAVAILABLE: 'เริ่มทดลองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
};

export function trialFailureMessage(code: TrialFailureCode): string {
  return TRIAL_FAILURE_MESSAGES[code] ?? TRIAL_FAILURE_MESSAGES.UNAVAILABLE;
}

/**
 * Why an administrator is not offered the trial. It lives here with the rest of
 * the trial copy rather than beside the action, because a `'use server'` module
 * may only export functions — and because this sentence is shown in two places.
 */
export const ADMIN_TRIAL_BLOCKED_MESSAGE =
  'บัญชีผู้ดูแลระบบมีสิทธิ์ Elite อยู่แล้ว จึงไม่ต้องเริ่มทดลอง — ใช้ “ทดสอบการเข้าถึงในแพ็กเกจ” เพื่อจำลอง Elite Trial แทน';

/**
 * Maps a PostgREST error onto a typed code. The database raises the code as the
 * exception message, so the match is on that text and nothing else — an
 * unrecognised failure stays `UNAVAILABLE` rather than being guessed at.
 */
export function trialFailureCode(error: unknown): TrialFailureCode {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return 'UNAVAILABLE';
  /*
   * The ledger's own refusals come back the same way — as the code in the
   * exception text — and are matched first. `TRIAL_IDENTITY_ALREADY_USED` does
   * not contain `TRIAL_ALREADY_USED` as a substring, so the two cannot be
   * confused for each other whichever order they are tried in; the order here
   * is for readers, not for correctness.
   */
  const identityCodes: TrialFailureCode[] = [
    'TRIAL_IDENTITY_ALREADY_USED',
    'TRIAL_IDENTITY_UNAVAILABLE',
    'ACCOUNT_DELETING',
  ];
  const matchedIdentity = identityCodes.find((code) => message.includes(code));
  if (matchedIdentity) return matchedIdentity;
  const matched = trialErrorCodes.find((code) => message.includes(code));
  return matched ?? 'UNAVAILABLE';
}
