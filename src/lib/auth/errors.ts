/**
 * Turns anything an auth provider can hand back into one of a fixed set of Thai
 * sentences.
 *
 * Provider text is never forwarded. It is English, it leaks implementation
 * detail ("Database error saving new user", table names, Go stack context), and
 * on the sign-in path it is the difference between "wrong password" and "this
 * address has no account" — an enumeration oracle. Every branch here returns a
 * literal defined in this file; nothing derived from `error.message` is ever
 * shown or interpolated.
 */

export type AuthErrorContext = 'sign-in' | 'sign-up' | 'forgot-password' | 'reset-password' | 'oauth';

export const GENERIC_AUTH_ERROR = 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
export const OFFLINE_ERROR = 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
export const RATE_LIMITED_ERROR = 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
export const EXPIRED_LINK_ERROR = 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่';

interface NormalizedAuthError {
  code: string;
  status: number | null;
  name: string;
}

function normalize(error: unknown): NormalizedAuthError {
  if (!error || typeof error !== 'object') return { code: '', status: null, name: '' };
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown; error_code?: unknown };
  const code = typeof candidate.code === 'string'
    ? candidate.code
    : typeof candidate.error_code === 'string' ? candidate.error_code : '';
  return {
    code: code.toLowerCase(),
    status: typeof candidate.status === 'number' ? candidate.status : null,
    name: typeof candidate.name === 'string' ? candidate.name : '',
  };
}

/** Codes that mean "the emailed link is spent, forged, or too old". */
const EXPIRED_LINK_CODES = new Set([
  'otp_expired',
  'flow_state_expired',
  'flow_state_not_found',
  'bad_code_verifier',
  'bad_jwt',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'validation_failed',
]);

const RATE_LIMIT_CODES = new Set([
  'over_request_rate_limit',
  'over_email_send_rate_limit',
  'over_sms_send_rate_limit',
  'request_timeout',
]);

const CONTEXT_FALLBACK: Record<AuthErrorContext, string> = {
  'sign-in': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'sign-up': 'สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  'forgot-password': GENERIC_AUTH_ERROR,
  'reset-password': GENERIC_AUTH_ERROR,
  oauth: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
};

export function describeAuthError(error: unknown, context: AuthErrorContext): string {
  const { code, status, name } = normalize(error);

  // A failed fetch is the browser/runtime, not the provider: no code, no status.
  if (name === 'AuthRetryableFetchError' || name === 'TypeError' || (!code && status === 0)) return OFFLINE_ERROR;

  if (RATE_LIMIT_CODES.has(code) || status === 429) return RATE_LIMITED_ERROR;
  if (EXPIRED_LINK_CODES.has(code) && context !== 'sign-in') return EXPIRED_LINK_ERROR;

  switch (code) {
    case 'invalid_credentials':
      // Same sentence whether the address is unknown or the password is wrong.
      return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
    case 'email_not_confirmed':
      return 'ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ยืนยันในอีเมลของคุณก่อน';
    case 'weak_password':
      return 'รหัสผ่านยังไม่ผ่านเกณฑ์ความปลอดภัย กรุณาตั้งใหม่ตามเงื่อนไขด้านล่าง';
    case 'same_password':
      return 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'ขณะนี้ระบบปิดรับการสมัครสมาชิกชั่วคราว';
    case 'provider_disabled':
    case 'oauth_provider_not_supported':
      return 'ขณะนี้ยังไม่เปิดให้เข้าสู่ระบบด้วยช่องทางนี้';
    case 'user_banned':
      return 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ';
    case 'session_expired':
      return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง';
    case 'reauthentication_needed':
      return 'กรุณาเข้าสู่ระบบใหม่อีกครั้งก่อนทำรายการนี้';
    default:
      break;
  }

  if (status === 422 && context === 'sign-up') return 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
  if (status !== null && status >= 500) return 'ระบบยืนยันตัวตนขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง';

  return CONTEXT_FALLBACK[context];
}

/**
 * OAuth providers report failure by redirecting back with `error` /
 * `error_code` query parameters. They are attacker-supplied (anyone can open
 * the callback URL with any parameters), so they select a message from this
 * table and are never echoed.
 */
export function describeOAuthCallbackError(params: URLSearchParams): string {
  const code = (params.get('error_code') ?? params.get('error') ?? '').toLowerCase();
  if (code === 'access_denied') return 'ยกเลิกการเข้าสู่ระบบด้วย Google แล้ว';
  if (code === 'server_error' || code === 'temporarily_unavailable') {
    return 'ผู้ให้บริการเข้าสู่ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'otp_expired' || code === 'flow_state_expired') return EXPIRED_LINK_ERROR;
  return CONTEXT_FALLBACK.oauth;
}
