import {
  DEFAULT_APPEARANCE,
  DEFAULT_THEME,
  normalizeAppearance,
  normalizeTheme,
  type ThemePreference,
} from './types';

export const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';
const LEGACY_KEYS = ['nexora-theme', 'theme-preference', 'appearance'];

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decode(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseThemePreference(value: unknown): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return { theme: DEFAULT_THEME, appearance: value };
  }
  if (value === 'Nexora AI Technical Dark') {
    return { theme: DEFAULT_THEME, appearance: 'dark' };
  }

  const root = record(value);
  const nested = record(root?.state) ?? record(root?.preferences) ?? root;
  return {
    theme: normalizeTheme(nested?.theme),
    appearance: normalizeAppearance(
      nested?.appearance ?? nested?.colorScheme ?? nested?.mode,
    ),
  };
}

export function readThemePreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  const current = storage.getItem(THEME_STORAGE_KEY);
  if (current != null) return parseThemePreference(decode(current));

  for (const key of LEGACY_KEYS) {
    const legacy = storage.getItem(key);
    if (legacy != null) return parseThemePreference(decode(legacy));
  }

  const appStore = record(decode(storage.getItem('nexora-ai-storage')));
  const appState = record(appStore?.state);
  if (appState && (
    'appearance' in appState
    || 'theme' in appState
    || 'colorScheme' in appState
    || 'mode' in appState
  )) {
    return parseThemePreference(appState);
  }

  return { theme: DEFAULT_THEME, appearance: DEFAULT_APPEARANCE };
}

export function writeThemePreference(
  storage: Pick<Storage, 'setItem'>,
  preference: ThemePreference,
): void {
  storage.setItem(THEME_STORAGE_KEY, JSON.stringify({
    theme: normalizeTheme(preference.theme),
    appearance: normalizeAppearance(preference.appearance),
  }));
}
