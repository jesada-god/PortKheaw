export const DEFAULT_THEME = 'portkheaw' as const;
export const DEFAULT_APPEARANCE = 'system' as const;

/**
 * Every colour theme the product ships, cheapest access first. PortKheaw is the
 * default and is available to everyone; the two that follow are paid.
 */
export const themeIds = ['portkheaw', 'bitswap', 'dokturek'] as const;

/**
 * The themes an account must hold Pro-or-better *effective access* to use.
 *
 * This list says which themes are gated. It deliberately does not say who may
 * have them — that is one question with one answer, the `theme.premium`
 * capability in the entitlement matrix, resolved on the server from the same
 * effective access tier every other gate reads.
 */
export const PREMIUM_THEMES = ['bitswap', 'dokturek'] as const;

export type ThemeId = typeof themeIds[number];
export type PremiumThemeId = typeof PREMIUM_THEMES[number];
export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedAppearance = Exclude<Appearance, 'system'>;

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
  /** True when using this theme requires the `theme.premium` capability. */
  premium: boolean;
}

export interface ThemePreference {
  theme: ThemeId;
  appearance: Appearance;
}

export function isPremiumTheme(theme: ThemeId): theme is PremiumThemeId {
  return (PREMIUM_THEMES as readonly ThemeId[]).includes(theme);
}

export function normalizeTheme(value: unknown): ThemeId {
  return (themeIds as readonly unknown[]).includes(value) ? value as ThemeId : DEFAULT_THEME;
}

/**
 * The theme that may actually paint, given what the reader is entitled to.
 *
 * This is the whole gate, and it is deliberately one pure function so that the
 * pre-paint script, the provider, the settings control and the tests all reach
 * the same verdict rather than each re-deriving it. It fails closed: anything
 * that is not a recognised theme, and any premium theme without the entitlement,
 * resolves to PortKheaw.
 */
export function resolveTheme(value: unknown, premiumAllowed: boolean): ThemeId {
  const theme = normalizeTheme(value);
  return isPremiumTheme(theme) && !premiumAllowed ? DEFAULT_THEME : theme;
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
