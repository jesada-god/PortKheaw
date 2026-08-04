import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const originalSha = process.env.PORTKHEAW_COMMIT_SHA;
const originalBuildTime = process.env.PORTKHEAW_BUILD_TIME;

afterEach(() => {
  process.env.PORTKHEAW_COMMIT_SHA = originalSha;
  process.env.PORTKHEAW_BUILD_TIME = originalBuildTime;
});

describe('GET /api/version', () => {
  it('returns only normalized deployment evidence without caching', async () => {
    process.env.PORTKHEAW_COMMIT_SHA = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    process.env.PORTKHEAW_BUILD_TIME = '2026-08-04T05:00:00+07:00';

    const response = await GET();

    expect(await response.json()).toEqual({
      commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      buildTime: '2026-08-03T22:00:00.000Z',
    });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('fails closed to public placeholders for malformed values', async () => {
    process.env.PORTKHEAW_COMMIT_SHA = 'secret-looking-but-not-a-sha';
    process.env.PORTKHEAW_BUILD_TIME = 'not-a-date';
    const response = await GET();
    expect(await response.json()).toEqual({ commitSha: 'unknown', buildTime: null });
  });
});
