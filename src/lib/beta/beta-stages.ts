/**
 * The controlled rollout, as a pure decision.
 *
 * Four stages and one question: may *this* reader start a new purchase? The
 * database answers it authoritatively in `resolve_my_beta_access`, and this
 * module holds the same rule so a server component can decide what to render
 * without a second round trip, and so the stage vocabulary, the cohort bands and
 * the reader-facing copy live in one place.
 *
 * Two things this deliberately does **not** gate: the product, and money already
 * taken. A reader who paid keeps every feature, every renewal, the billing
 * portal, refunds and support, in every stage including `closed`. A rollout stage
 * decides who may *join*, never what a member already has — anything else would
 * be taking away something somebody bought.
 */

export const betaStages = ['closed', 'beta_5_10', 'beta_20_50', 'public'] as const;
export type BetaStage = typeof betaStages[number];

/** Anything unrecognised is `closed`. Fail closed: the failure mode is a refusal. */
export function normalizeBetaStage(value: unknown): BetaStage {
  return betaStages.includes(value as BetaStage) ? value as BetaStage : 'closed';
}

/**
 * The cohort size each stage admits, as a band.
 *
 * The names carry the numbers — `beta_5_10` is a first cohort of five to ten —
 * and an operator picks a size inside the band. `public` is uncapped, which the
 * database expresses as `-1`; `closed` admits nobody new, which is a cap of zero.
 *
 * The same table exists in the migration, and a test asserts the two agree. A
 * disagreement would mean the console offering a cohort size the routine refuses.
 */
export interface BetaCapBand {
  min: number;
  /** `-1` means uncapped. It is never a cohort size. */
  max: number;
}

export const BETA_CAP_BANDS: Readonly<Record<BetaStage, BetaCapBand>> = {
  closed: { min: 0, max: 0 },
  beta_5_10: { min: 5, max: 10 },
  beta_20_50: { min: 20, max: 50 },
  public: { min: 0, max: -1 },
};

/** Whether a stage takes a cohort size at all. `closed` and `public` do not. */
export function stageAcceptsCap(stage: BetaStage): boolean {
  return stage === 'beta_5_10' || stage === 'beta_20_50';
}

/** The cohort sizes an operator may choose for a stage, for a select control. */
export function capChoices(stage: BetaStage): readonly number[] {
  if (!stageAcceptsCap(stage)) return [];
  const band = BETA_CAP_BANDS[stage];
  return Array.from({ length: band.max - band.min + 1 }, (_, index) => band.min + index);
}

export function capIsInBand(stage: BetaStage, cap: number | null): boolean {
  if (!stageAcceptsCap(stage)) return cap === null;
  if (cap === null) return true;
  const band = BETA_CAP_BANDS[stage];
  return Number.isInteger(cap) && cap >= band.min && cap <= band.max;
}

/**
 * Why a reader was admitted, or was not. The database returns these verbatim, so
 * the console and the reader-facing copy read one vocabulary.
 */
export const betaAccessReasons = [
  /** No program row. The one fail-open case — see the routine for why. */
  'unconfigured',
  'admin',
  'public_stage',
  /** The account predates the program. The non-regression rule. */
  'pre_existing_account',
  /** The account already pays. Also non-regression. */
  'existing_subscriber',
  'invited',
  'closed_stage',
  'not_invited',
  'unauthenticated',
] as const;
export type BetaAccessReason = typeof betaAccessReasons[number];

/**
 * Whether the answer below is the program's, or a stand-in for one that could
 * not be read.
 *
 * `admitted` cannot carry this on its own. A reader is either let in or not, and
 * both of those are answers; "we could not ask" is a third state, and the two
 * callers that hand out access — a new trial and a new purchase — have to be
 * able to tell it apart from an admission.
 */
export type BetaAccessResolution = 'resolved' | 'unavailable';

export interface BetaAccess {
  stage: BetaStage;
  admitted: boolean;
  reason: BetaAccessReason;
  isAdmin: boolean;
  /** `-1` when uncapped. */
  participantCap: number;
  activeInvites: number;
  /** `unavailable` means the program state could not be read at all. */
  resolution: BetaAccessResolution;
}

/**
 * What an unreadable program state resolves to.
 *
 * Still `admitted`, and still deliberately so: every surface that belongs to a
 * reader who is already inside — a running trial, a live subscription, the
 * renewal, the portal, support — must keep rendering when a rollout flag cannot
 * be read, and none of them may go dark over a flag.
 *
 * What it is *not* is a licence to hand out new access. `resolution` marks the
 * answer as absent, and the two acquisition paths refuse on it rather than on
 * `admitted` — see `startEliteTrialAction` and `startCheckoutAction`. The
 * database re-checks authorization either way; this is the gate that stops a
 * closed stage from being walked around during an outage of its own reader.
 */
export const UNKNOWN_BETA_ACCESS: BetaAccess = {
  stage: 'public',
  admitted: true,
  reason: 'unconfigured',
  isAdmin: false,
  participantCap: -1,
  activeInvites: 0,
  resolution: 'unavailable',
};

/**
 * What a reader is told when the rollout could not be read.
 *
 * Temporary, and says so: nothing is wrong with their account, the attempt is
 * worth repeating, and no waitlist or refusal is implied — because none was
 * decided. Shared by the trial and the checkout so one outage speaks with one
 * voice.
 */
export const BETA_ACCESS_UNAVAILABLE_MESSAGE =
  'ไม่สามารถตรวจสอบสิทธิ์การเข้าร่วมได้ชั่วคราว กรุณาลองใหม่อีกครั้ง';

/** Whether a new trial or a new purchase may be started from this answer. */
export function betaAccessAdmitsAcquisition(access: BetaAccess): boolean {
  return access.resolution === 'resolved' && access.admitted;
}

export interface BetaAccessInput {
  stage: unknown;
  isAdmin: boolean;
  /** Whether this reader's mailbox is on the active allowlist. */
  invited: boolean;
  /** Whether the account existed before the program was introduced. */
  preExisting: boolean;
  /** Whether the account already holds a live paid or trialing subscription. */
  subscriber: boolean;
  authenticated: boolean;
}

/**
 * The same four ways in the database applies, in the same order.
 *
 * Kept in step with `resolve_my_beta_access` by a test that runs both. This copy
 * exists so a page can render the right thing in one round trip; the database's
 * copy is the one that decides whether money changes hands.
 */
export function resolveBetaAccess(input: BetaAccessInput): Pick<BetaAccess, 'stage' | 'admitted' | 'reason'> {
  const stage = normalizeBetaStage(input.stage);
  if (!input.authenticated) return { stage, admitted: false, reason: 'unauthenticated' };
  if (input.isAdmin) return { stage, admitted: true, reason: 'admin' };
  if (stage === 'public') return { stage, admitted: true, reason: 'public_stage' };

  if (stage === 'closed') {
    if (input.subscriber) return { stage, admitted: true, reason: 'existing_subscriber' };
    if (input.preExisting) return { stage, admitted: true, reason: 'pre_existing_account' };
    return { stage, admitted: false, reason: 'closed_stage' };
  }

  if (input.invited) return { stage, admitted: true, reason: 'invited' };
  if (input.subscriber) return { stage, admitted: true, reason: 'existing_subscriber' };
  if (input.preExisting) return { stage, admitted: true, reason: 'pre_existing_account' };
  return { stage, admitted: false, reason: 'not_invited' };
}

/** What an operator sees on the stage control. */
export const BETA_STAGE_LABEL: Readonly<Record<BetaStage, string>> = {
  closed: 'ปิดรับสมาชิกใหม่',
  beta_5_10: 'ทดลองวงปิด 5–10 บัญชี',
  beta_20_50: 'ทดลองวงขยาย 20–50 บัญชี',
  public: 'เปิดสาธารณะ',
};

export const BETA_STAGE_DESCRIPTION: Readonly<Record<BetaStage, string>> = {
  closed: 'ผู้ใช้ใหม่ยังสมัครแพ็กเกจไม่ได้ สมาชิกเดิมและผู้ที่ชำระเงินแล้วใช้งานได้ตามปกติ',
  beta_5_10: 'เฉพาะบัญชีที่ได้รับเชิญเท่านั้นที่สมัครแพ็กเกจได้ จำกัดจำนวนตามโควตาที่ตั้งไว้',
  beta_20_50: 'ขยายวงผู้ได้รับเชิญ ยังไม่เปิดให้บุคคลทั่วไปสมัคร',
  public: 'เปิดให้ทุกคนสมัครแพ็กเกจได้',
};

/**
 * What a reader outside the active stage is told.
 *
 * It says three things on purpose: that the product is in a limited rollout, that
 * nothing is wrong with their account, and what happens next. A bare "unavailable"
 * reads as a fault and sends people to support.
 */
export interface BetaWaitlistCopy {
  title: string;
  body: string;
  /** Shown only where support is genuinely the next step. */
  supportHint: string;
}

export function betaWaitlistCopy(reason: BetaAccessReason, stage: BetaStage): BetaWaitlistCopy {
  if (reason === 'unauthenticated') {
    return {
      title: 'เข้าสู่ระบบก่อนสมัครแพ็กเกจ',
      body: 'กรุณาเข้าสู่ระบบ แล้วกลับมาที่หน้านี้อีกครั้ง',
      supportHint: '',
    };
  }

  if (stage === 'closed') {
    return {
      title: 'ยังไม่เปิดรับสมาชิกใหม่',
      body: 'ขณะนี้ PortKheaw ยังไม่เปิดให้สมัครแพ็กเกจใหม่ บัญชีของคุณยังใช้งานฟีเจอร์ฟรีได้ตามปกติ และเราจะแจ้งให้ทราบเมื่อเปิดรับ',
      supportHint: 'หากคุณเคยชำระเงินไว้แล้วแต่เห็นข้อความนี้ กรุณาติดต่อทีมงานเพื่อให้เราตรวจสอบให้',
    };
  }

  return {
    title: 'อยู่ในช่วงทดลองใช้แบบจำกัดจำนวน',
    body: 'ตอนนี้เปิดให้เฉพาะบัญชีที่ได้รับเชิญสมัครแพ็กเกจได้ บัญชีของคุณยังใช้งานฟีเจอร์ฟรีได้ตามปกติ และจะได้รับสิทธิ์สมัครเมื่อเราขยายรอบถัดไป',
    supportHint: 'หากคุณได้รับคำเชิญแล้วแต่ยังสมัครไม่ได้ กรุณาติดต่อทีมงานพร้อมแจ้งอีเมลที่ใช้รับคำเชิญ',
  };
}

/** Outcomes the operator routines return, mapped to what an operator is told. */
export const BETA_OUTCOME_MESSAGE: Readonly<Record<string, string>> = {
  updated: 'บันทึกการเปลี่ยนสถานะแล้ว',
  unchanged: 'สถานะเดิมอยู่แล้ว ไม่มีการเปลี่ยนแปลง',
  invalid_stage: 'ไม่รู้จักสถานะที่เลือก',
  cap_out_of_band: 'จำนวนโควตาอยู่นอกช่วงที่สถานะนี้อนุญาต',
  not_found: 'ไม่พบข้อมูลโปรแกรมทดลองใช้',
  invited: 'เพิ่มคำเชิญแล้ว',
  already_invited: 'อีเมลนี้อยู่ในรายชื่อผู้ได้รับเชิญแล้ว',
  cap_reached: 'จำนวนผู้ได้รับเชิญครบโควตาของสถานะนี้แล้ว',
  invalid_email: 'รูปแบบอีเมลไม่ถูกต้อง',
  revoked: 'ยกเลิกคำเชิญแล้ว',
};
