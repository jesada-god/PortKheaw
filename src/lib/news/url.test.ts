import { describe, expect, it } from 'vitest';
import { canonicalNewsUrl, safeExternalUrl } from './url';
describe('safeExternalUrl', () => { it('allows only http(s) links', () => {
  expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a');
  expect(safeExternalUrl('javascript:alert(1)')).toBeNull(); expect(safeExternalUrl('not a url')).toBeNull();
}); });

describe('canonicalNewsUrl', () => {
  it('treats www, trailing slash and campaign parameters as the same article', () => {
    const canonical = canonicalNewsUrl('https://publisher.com/story');
    expect(canonicalNewsUrl('https://www.publisher.com/story/')).toBe(canonical);
    expect(canonicalNewsUrl('https://publisher.com/story?utm_source=rss&fbclid=abc')).toBe(canonical);
  });

  it('keeps parameters that identify the article', () => {
    expect(canonicalNewsUrl('https://publisher.com/a?p=1'))
      .not.toBe(canonicalNewsUrl('https://publisher.com/a?p=2'));
  });

  it('is order-independent for the parameters it keeps', () => {
    expect(canonicalNewsUrl('https://publisher.com/a?b=2&a=1'))
      .toBe(canonicalNewsUrl('https://publisher.com/a?a=1&b=2'));
  });

  it('returns null for links it cannot reduce, so callers do not merge unrelated items', () => {
    expect(canonicalNewsUrl('not a url')).toBeNull();
    expect(canonicalNewsUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalNewsUrl(null)).toBeNull();
  });
});
