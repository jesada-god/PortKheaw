/**
 * What the deletion dialog says, and the shape its answer comes back in.
 *
 * A plain module rather than part of the action, because a `'use server'` file
 * may only export functions and the dialog needs the same words the server does.
 * Nothing here is a decision — every sentence describes something the pipeline
 * actually does, and the migration and the pipeline tests are what make that
 * true.
 */

/**
 * The word that has to be typed, in the language the dialog is written in.
 *
 * Typing an English word into a Thai warning is a reflex, not a decision, and
 * the point of this field is to interrupt the reflex.
 */
export const DELETE_ACCOUNT_CONFIRMATION = 'ลบบัญชี';

export type DeleteAccountFailure =
  | 'not-confirmed'
  | 'unauthenticated'
  | 'password-required'
  | 'password-rejected'
  | 'reauth-stale'
  | 'reauth-unavailable'
  | 'provider-failed'
  /**
   * The security lockdown is engaged. Named separately from `unavailable`
   * because it is not a failure and will not clear by retrying — the reader
   * should be told to come back later rather than press the button again
   * against a control that is deliberately closed.
   */
  | 'locked-down'
  | 'unavailable';

export interface DeleteAccountState {
  status: 'idle' | 'error';
  message?: string;
  /** Which field to point at, when the failure belongs to one. */
  field?: 'confirmation' | 'password';
}

export const IDLE_DELETE_ACCOUNT_STATE: DeleteAccountState = { status: 'idle' };

/**
 * Every refusal, in the reader's language, saying what to do next.
 *
 * None of them names a table, a provider, an environment variable or an internal
 * code, and none of them leaks whether a mailbox is registered — the person is
 * already signed in, so there is nothing to learn, but the habit is what keeps
 * it that way when the copy is next edited.
 */
export const DELETE_ACCOUNT_MESSAGE: Readonly<Record<DeleteAccountFailure, string>> = {
  'not-confirmed': `กรุณาพิมพ์ “${DELETE_ACCOUNT_CONFIRMATION}” ให้ตรงเพื่อยืนยัน`,
  unauthenticated: 'เซสชันหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
  'password-required': 'กรุณากรอกรหัสผ่านของคุณเพื่อยืนยันตัวตน',
  'password-rejected': 'รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง',
  'reauth-stale': 'เพื่อความปลอดภัย กรุณาเข้าสู่ระบบใหม่อีกครั้งก่อนลบบัญชี',
  'reauth-unavailable': 'ยืนยันตัวตนไม่สำเร็จในขณะนี้ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
  'provider-failed': 'ยังยกเลิกการเรียกเก็บเงินไม่สำเร็จ จึงยังไม่ลบบัญชี กรุณาลองใหม่อีกครั้ง',
  // Says the operation is paused and does not say why. A reader learning that a
  // security incident is in progress is an invitation, not an explanation.
  'locked-down': 'ขณะนี้ระบบพักการลบบัญชีชั่วคราวเพื่อความปลอดภัย กรุณาลองใหม่ในภายหลัง',
  unavailable: 'ลบบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
};

export function deleteAccountMessage(failure: DeleteAccountFailure): string {
  return DELETE_ACCOUNT_MESSAGE[failure];
}

/** Shown on the sign-in page once the account is gone. */
export const DELETE_ACCOUNT_SUCCESS_MESSAGE = 'ลบบัญชีเรียบร้อยแล้ว ขอบคุณที่ใช้งาน PortKheaw';

/**
 * The consequences, in the order somebody weighing the decision needs them.
 *
 * Each line is a promise the code keeps: the first is `purge_account_data`, the
 * second is the trial ledger, the third is what that ledger holds, and the
 * fourth is the one thing deletion deliberately does *not* do.
 */
export const DELETE_ACCOUNT_CONSEQUENCES: readonly string[] = [
  'พอร์ตการลงทุน รายการติดตาม การแจ้งเตือน การตั้งค่า และข้อมูลส่วนตัวของคุณจะถูกลบถาวร และกู้คืนไม่ได้',
  'สิทธิทดลองฟรีจะสิ้นสุดทันที และหากสมัครใหม่ด้วยอีเมลหรือบัญชี Google เดิม จะไม่ได้รับสิทธิทดลองอีก',
  'เราเก็บเฉพาะข้อมูลแบบแฮชที่ไม่แสดงอีเมลของคุณโดยตรง เท่าที่จำเป็นเพื่อป้องกันการใช้สิทธิทดลองซ้ำ',
  'การลบบัญชีไม่ใช่การขอคืนเงินอัตโนมัติ หากต้องการขอคืนเงิน กรุณายื่นคำขอก่อนลบบัญชี',
];
