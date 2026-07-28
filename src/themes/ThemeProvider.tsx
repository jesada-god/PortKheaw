'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_THEME,
  resolveAppearance,
  type Appearance,
  type ResolvedAppearance,
  type ThemeId,
} from './types';
import { readThemePreference, writeThemePreference } from './storage';

export const APPEARANCE_CHANGE_EVENT = 'portkheaw:appearance-change';

interface ThemeContextValue {
  theme: ThemeId;
  appearance: Appearance;
  resolvedAppearance: ResolvedAppearance;
  setAppearance: (appearance: Appearance) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyToDocument(theme: ThemeId, resolved: ResolvedAppearance): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.appearance = resolved;
  root.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, {
    detail: { theme, resolvedAppearance: resolved },
  }));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = DEFAULT_THEME;
  const [appearance, setAppearanceState] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [resolvedAppearance, setResolvedAppearance] = useState<ResolvedAppearance>('dark');

  const sync = useCallback((nextTheme: ThemeId, nextAppearance: Appearance) => {
    const nextResolved = resolveAppearance(nextAppearance, systemPrefersDark());
    setResolvedAppearance(nextResolved);
    applyToDocument(nextTheme, nextResolved);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const preference = readThemePreference(window.localStorage);
      setAppearanceState(preference.appearance);
      writeThemePreference(window.localStorage, preference);
      sync(preference.theme, preference.appearance);
    });
    return () => { active = false; };
  }, [sync]);

  useEffect(() => {
    if (appearance !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => sync(theme, 'system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance, sync, theme]);

  const setAppearance = useCallback((nextAppearance: Appearance) => {
    setAppearanceState(nextAppearance);
    writeThemePreference(window.localStorage, { theme, appearance: nextAppearance });
    sync(theme, nextAppearance);
  }, [sync, theme]);

  const value = useMemo(() => ({
    theme,
    appearance,
    resolvedAppearance,
    setAppearance,
  }), [appearance, resolvedAppearance, setAppearance, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
