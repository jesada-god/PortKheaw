import { describe, expect, it } from 'vitest';
import { newsErrorMessage, newsViewState, shouldRenderNewsImage } from './news-policy';
describe('NewsFeed states', () => {
  it('has distinct configuration, rate-limit, and provider error messages', () => { expect(newsErrorMessage('NEWS_PROVIDER_NOT_CONFIGURED')).toContain('ยังไม่ได้ตั้งค่า'); expect(newsErrorMessage('NEWS_PROVIDER_RATE_LIMITED')).toContain('จำกัดจำนวนคำขอ'); expect(newsErrorMessage('NEWS_PROVIDER_UPSTREAM_FAILURE')).toContain('ชั่วคราว'); });
  it('renders HTTPS publisher images except hosts proven to reject hotlinks', () => {
    expect(shouldRenderNewsImage(false, 'https://s.yimg.com/uu/api/res/1.2/image.jpg')).toBe(true);
    expect(shouldRenderNewsImage(false, 'https://biztoc.com/cdn/thumb.webp')).toBe(false);
    expect(shouldRenderNewsImage(false, 'https://cdn.biztoc.com/cdn/thumb.webp')).toBe(false);
    // Mixed content, missing images and Data Saver all suppress the thumbnail.
    expect(shouldRenderNewsImage(false, 'http://publisher.com/image.jpg')).toBe(false);
    expect(shouldRenderNewsImage(false, 'not a url')).toBe(false);
    expect(shouldRenderNewsImage(false, null)).toBe(false);
    expect(shouldRenderNewsImage(true, 'https://s.yimg.com/image.jpg')).toBe(false);
  });
  it('separates empty, configuration, rate-limit, error, and loading states', () => {
    expect(newsViewState(0, true)).toBe('loading'); expect(newsViewState(0, false)).toBe('empty');
    expect(newsViewState(0, false, 'NEWS_PROVIDER_NOT_CONFIGURED')).toBe('configuration-required');
    expect(newsViewState(0, false, 'NEWS_PROVIDER_RATE_LIMITED')).toBe('rate-limited');
    expect(newsViewState(0, false, 'NEWS_PROVIDER_UPSTREAM_FAILURE')).toBe('error');
  });
});
