import {
  DEFAULT_THEME,
  normalizeTheme,
  type ThemeDefinition,
  type ThemeId,
} from './types';

export const themeRegistry = {
  portkheaw: {
    id: 'portkheaw',
    label: 'PortKheaw',
    description: 'รูปแบบสีและเอกลักษณ์ของแอป',
  },
} as const satisfies Record<ThemeId, ThemeDefinition>;

export function getTheme(value: unknown): ThemeDefinition {
  return themeRegistry[normalizeTheme(value)] ?? themeRegistry[DEFAULT_THEME];
}
