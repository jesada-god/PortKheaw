/**
 * Whether an article's own image may be requested.
 *
 * The set of publisher CDNs behind a news feed is unbounded and changes per
 * article (`biztoc.com`, `s.yimg.com`, `media.cnn.com`, …), so a hostname
 * allowlist cannot express "this article's real picture" — the previous one
 * admitted a single placeholder-image service, which meant no genuine thumbnail
 * ever rendered. The rule that actually protects the reader is transport, not
 * host: HTTPS only (an `http:` thumbnail is mixed content and would be blocked
 * anyway), matched by `img-src 'self' data: blob: https:` in the middleware CSP.
 * Data Saver still suppresses every image request.
 */
export function shouldRenderNewsImage(saveData: boolean, imageUrl: string | null) {
  if (saveData || !imageUrl) return false;
  try {
    return new URL(imageUrl).protocol === 'https:';
  } catch {
    return false;
  }
}
export function newsErrorMessage(code: string) {
  if (code === 'NEWS_PROVIDER_NOT_CONFIGURED') return 'ยังไม่สามารถโหลดข่าวได้ — ระบบข่าวยังไม่ได้ตั้งค่า';
  if (code === 'NEWS_PROVIDER_RATE_LIMITED') return 'ยังไม่สามารถโหลดข่าวได้ — ผู้ให้บริการจำกัดจำนวนคำขอชั่วคราว';
  if (code === 'NEWS_PROVIDER_TIMEOUT') return 'ยังไม่สามารถโหลดข่าวได้ — ผู้ให้บริการตอบช้าเกินไป';
  if (code === 'NEWS_PROVIDER_INVALID_KEY') return 'ยังไม่สามารถโหลดข่าวได้ — การตั้งค่าผู้ให้บริการไม่ถูกต้อง';
  return 'ยังไม่สามารถโหลดข่าวได้ — ผู้ให้บริการไม่พร้อมใช้งานชั่วคราว';
}
export type NewsViewState = 'loading' | 'empty' | 'configuration-required' | 'rate-limited' | 'error' | 'ready';
export function newsViewState(itemCount: number, loading: boolean, errorCode?: string): NewsViewState {
  if (loading && itemCount === 0) return 'loading';
  if (itemCount > 0) return 'ready';
  if (errorCode === 'NEWS_PROVIDER_NOT_CONFIGURED') return 'configuration-required';
  if (errorCode === 'NEWS_PROVIDER_RATE_LIMITED') return 'rate-limited';
  if (errorCode) return 'error';
  return 'empty';
}
