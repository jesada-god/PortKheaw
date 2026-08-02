/**
 * One place that turns a database entitlement refusal into the sentence a
 * reader sees. Both portfolio action modules raise the same three codes from
 * the same RPCs, so the mapping lives here instead of being written twice and
 * drifting apart.
 *
 * The database raises these as `CODE:detail` in the exception message; nothing
 * here trusts a value the client supplied.
 */

export const entitlementFailureCodes = [
  'UPGRADE_REQUIRED',
  'READ_ONLY_SUBSCRIPTION',
  'LIMIT_REACHED',
] as const;
export type EntitlementFailureCode = typeof entitlementFailureCodes[number];

export interface EntitlementFailure {
  code: EntitlementFailureCode;
  message: string;
}

/** Shown wherever an over-limit portfolio refuses a write. */
export const READ_ONLY_PORTFOLIO_MESSAGE = 'พอร์ตนี้ยังเปิดดูได้ แต่ต้องใช้ Pro เพื่อแก้ไขต่อ';

export function entitlementFailure(error: unknown): EntitlementFailure | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;

  if (message.includes('READ_ONLY_SUBSCRIPTION')) {
    return { code: 'READ_ONLY_SUBSCRIPTION', message: READ_ONLY_PORTFOLIO_MESSAGE };
  }

  if (message.includes('UPGRADE_REQUIRED')) {
    // Creating an options portfolio and editing an existing one are different
    // moments in the reader's day and deserve different sentences.
    const editing = message.includes('portfolio.options.write');
    return {
      code: 'UPGRADE_REQUIRED',
      message: editing
        ? 'พอร์ต Options แก้ไขได้เมื่อใช้ Pro ขึ้นไป ตอนนี้ยังเปิดดูข้อมูลเดิมได้ครบ'
        : 'พอร์ต Options ใช้ได้ใน Pro',
    };
  }

  if (message.includes('LIMIT_REACHED')) {
    const maximum = message.match(/LIMIT_REACHED:[A-Z]+:(\d+)/)?.[1] ?? '10';
    return {
      code: 'LIMIT_REACHED',
      message: `สร้างพอร์ตประเภทนี้ได้สูงสุด ${maximum} พอร์ต`,
    };
  }

  return null;
}
