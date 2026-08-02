import { describe, expect, it, vi } from 'vitest';
import {
  decodeVapidPublicKey,
  resolvePushDeviceState,
} from './client';

describe('push device state', () => {
  it.each([
    {
      name: 'default permission',
      input: {
        supported: true,
        permission: 'default' as const,
        subscribed: false,
        configured: true,
      },
      expected: 'off',
    },
    {
      name: 'granted and subscribed',
      input: {
        supported: true,
        permission: 'granted' as const,
        subscribed: true,
        configured: true,
      },
      expected: 'on',
    },
    {
      name: 'denied',
      input: {
        supported: true,
        permission: 'denied' as const,
        subscribed: false,
        configured: true,
      },
      expected: 'blocked',
    },
    {
      name: 'unsupported',
      input: {
        supported: false,
        permission: 'default' as const,
        subscribed: false,
        configured: true,
      },
      expected: 'unsupported',
    },
  ])('resolves $name from browser truth', ({ input, expected }) => {
    expect(resolvePushDeviceState(input)).toBe(expected);
  });

  it('decodes the URL-safe public key without touching a private key', () => {
    vi.stubGlobal('atob', (value: string) =>
      Buffer.from(value, 'base64').toString('binary'));
    expect([...decodeVapidPublicKey('AQIDBA')]).toEqual([1, 2, 3, 4]);
    vi.unstubAllGlobals();
  });
});
