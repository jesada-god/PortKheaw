import { describe, expect, it } from 'vitest';
import { getTheme } from './registry';
import {
  parseThemePreference,
  readThemePreference,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from './storage';
import { normalizeAppearance, resolveAppearance } from './types';

function memoryStorage(values: Record<string, string> = {}) {
  return {
    getItem(key: string) { return values[key] ?? null; },
    setItem(key: string, value: string) { values[key] = value; },
    values,
  };
}

describe('PortKheaw theme preferences', () => {
  it('uses PortKheaw for the default and unknown theme', () => {
    expect(getTheme(undefined).id).toBe('portkheaw');
    expect(getTheme('unknown').id).toBe('portkheaw');
  });

  it('accepts system/light/dark and falls back invalid appearance to system', () => {
    expect(normalizeAppearance('system')).toBe('system');
    expect(normalizeAppearance('light')).toBe('light');
    expect(normalizeAppearance('dark')).toBe('dark');
    expect(normalizeAppearance('sepia')).toBe('system');
  });

  it('resolves system from the OS while manual modes override it', () => {
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('light', true)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
  });

  it('migrates legacy scalar and nested preferences without reading other settings', () => {
    expect(parseThemePreference('dark')).toEqual({ theme: 'portkheaw', appearance: 'dark' });
    expect(parseThemePreference('Nexora AI Technical Dark')).toEqual({
      theme: 'portkheaw',
      appearance: 'dark',
    });
    expect(parseThemePreference({ state: { theme: 'old', appearance: 'light', currency: 'THB' } }))
      .toEqual({ theme: 'portkheaw', appearance: 'light' });
  });

  it('recovers corrupted data and persists appearance=system, not its resolution', () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: '{broken' });
    expect(readThemePreference(storage)).toEqual({ theme: 'portkheaw', appearance: 'system' });
    writeThemePreference(storage, { theme: 'portkheaw', appearance: 'system' });
    expect(JSON.parse(storage.values[THEME_STORAGE_KEY])).toEqual({
      theme: 'portkheaw',
      appearance: 'system',
    });
  });
});
