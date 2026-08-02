import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { parseServerEnv } from './server';

describe('server environment parsing', () => {
  it('preserves a valid Alpha Vantage key when an unrelated optional value is invalid', () => {
    const parsed = parseServerEnv({
      APP_URL: 'not-a-url',
      ALPHA_VANTAGE_API_KEY: 'valid-provider-key',
    });

    expect(parsed.data.ALPHA_VANTAGE_API_KEY).toBe(
      'valid-provider-key',
    );
    expect(parsed.data.APP_URL).toBeUndefined();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ path: 'APP_URL' }),
    ]);
  });

  it('parses the Polygon production market-data configuration', () => {
    const parsed = parseServerEnv({
      POLYGON_API_KEY: 'polygon-secret',
      MARKET_DATA_PROVIDER: 'polygon',
    });

    expect(parsed.data.POLYGON_API_KEY).toBe('polygon-secret');
    expect(parsed.data.MARKET_DATA_PROVIDER).toBe('polygon');
    expect(parsed.issues).toEqual([]);
  });

  it('treats blank Polygon values as unset without raising configuration issues', () => {
    const parsed = parseServerEnv({ POLYGON_API_KEY: '', MARKET_DATA_PROVIDER: '' });

    expect(parsed.data.POLYGON_API_KEY).toBeUndefined();
    expect(parsed.data.MARKET_DATA_PROVIDER).toBeUndefined();
    expect(parsed.issues).toEqual([]);
  });

  it('parses only the explicit public/private push variable boundary', () => {
    const parsed = parseServerEnv({
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'browser-safe-key',
      VAPID_PRIVATE_KEY: 'server-secret-key',
      VAPID_SUBJECT: 'https://portkheaw.vercel.app',
    });

    expect(parsed.data.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      .toBe('browser-safe-key');
    expect(parsed.data.VAPID_PRIVATE_KEY).toBe('server-secret-key');
    expect(parsed.data.VAPID_SUBJECT)
      .toBe('https://portkheaw.vercel.app');
    expect(parsed.data).not.toHaveProperty('WEB_PUSH_VAPID_PRIVATE_KEY');
    expect(parsed.issues).toEqual([]);
  });
});
