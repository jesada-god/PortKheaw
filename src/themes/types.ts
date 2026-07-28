export const DEFAULT_THEME = 'portkheaw' as const;
export const DEFAULT_APPEARANCE = 'system' as const;

export type ThemeId = typeof DEFAULT_THEME;
export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedAppearance = Exclude<Appearance, 'system'>;

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
}

export interface ThemePreference {
  theme: ThemeId;
  appearance: Appearance;
}

export function normalizeTheme(value: unknown): ThemeId {
  return value === DEFAULT_THEME ? value : DEFAULT_THEME;
}

export function normalizeAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_APPEARANCE;
}

export function resolveAppearance(
  appearance: Appearance,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  return appearance === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : appearance;
}
