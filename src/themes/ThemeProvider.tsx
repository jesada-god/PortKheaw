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
  resolveTheme,
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
  /** Server-resolved: whether this reader's effective tier opens the paid themes. */
  premiumThemesAllowed: boolean;
  setTheme: (theme: ThemeId) => void;
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

export interface ThemeProviderProps {
  /**
   * Whether the reader's *effective access* tier carries `theme.premium`,
   * resolved on the server. It is a prop rather than something read here so the
   * provider has no second opinion about entitlement — the head script, this
   * component and the settings control all follow the one server answer.
   */
  premiumThemesAllowed?: boolean;
  children: ReactNode;
}

export function ThemeProvider({ premiumThemesAllowed = false, children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [appearance, setAppearanceState] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [resolvedAppearance, setResolvedAppearance] = useState<ResolvedAppearance>('dark');

  const sync = useCallback((nextTheme: ThemeId, nextAppearance: Appearance) => {
    const nextResolved = resolveAppearance(nextAppearance, systemPrefersDark());
    setResolvedAppearance(nextResolved);
    applyToDocument(nextTheme, nextResolved);
  }, []);

  /*
   * Reconciliation, run on mount and again whenever the server's answer changes.
   *
   * The stored theme is only a request: it goes through `resolveTheme` with the
   * entitlement before anything is applied, so a lapsed subscription drops the
   * reader back to PortKheaw. The corrected value is written straight back to
   * storage — otherwise the next reload would ask for the premium theme again —
   * and the appearance is written back untouched, because losing a plan must
   * never also change whether the app is light or dark.
   */
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const preference = readThemePreference(window.localStorage);
      const allowed = resolveTheme(preference.theme, premiumThemesAllowed);
      setThemeState(allowed);
      setAppearanceState(preference.appearance);
      writeThemePreference(window.localStorage, {
        theme: allowed,
        appearance: preference.appearance,
      });
      sync(allowed, preference.appearance);
    });
    return () => { active = false; };
  }, [premiumThemesAllowed, sync]);

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

  /**
   * Refuses rather than trusts. A caller asking for a premium theme without the
   * entitlement gets PortKheaw persisted, so a tampered UI cannot leave the
   * stored preference pointing at a theme the reader may not have.
   */
  const setTheme = useCallback((nextTheme: ThemeId) => {
    const allowed = resolveTheme(nextTheme, premiumThemesAllowed);
    setThemeState(allowed);
    writeThemePreference(window.localStorage, { theme: allowed, appearance });
    sync(allowed, appearance);
  }, [appearance, premiumThemesAllowed, sync]);

  const value = useMemo(() => ({
    theme,
    appearance,
    resolvedAppearance,
    premiumThemesAllowed,
    setTheme,
    setAppearance,
  }), [appearance, premiumThemesAllowed, resolvedAppearance, setAppearance, setTheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
