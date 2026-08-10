import {
  DEFAULT_THEME,
  isPremiumTheme,
  normalizeTheme,
  themeIds,
  type ThemeDefinition,
  type ThemeId,
} from './types';

export const themeRegistry = {
  portkheaw: {
    id: 'portkheaw',
    label: 'PortKheaw',
    description: 'รูปแบบสีและเอกลักษณ์ของแอป',
    premium: false,
  },
  bitswap: {
    id: 'bitswap',
    label: 'Bitswap Cyan',
    description: 'พื้นหลังเกือบดำ ตัดด้วยฟ้านีออนสำหรับสายข้อมูล',
    premium: true,
  },
  dokturek: {
    id: 'dokturek',
    label: 'Dokturek Violet',
    description: 'โทนม่วงนุ่ม อ่านสบายทั้งกลางวันและกลางคืน',
    premium: true,
  },
  cosmic: {
    id: 'cosmic',
    label: 'Cosmic Vanilla',
    description: 'คอสมิกเข้ม ตัดวานิลลานุ่ม',
    premium: true,
  },
  orchid: {
    id: 'orchid',
    label: 'Jet Black Orchid',
    description: 'ดำเจ็ตแบล็ก ตัดออร์คิดโทนนุ่ม',
    premium: true,
  },
} as const satisfies Record<ThemeId, ThemeDefinition>;

export const themeDefinitions: readonly ThemeDefinition[] = themeIds.map((id) => themeRegistry[id]);

export function getTheme(value: unknown): ThemeDefinition {
  return themeRegistry[normalizeTheme(value)] ?? themeRegistry[DEFAULT_THEME];
}

/** Kept beside the registry so a definition and its gate cannot disagree. */
export function isThemeAvailable(theme: ThemeId, premiumAllowed: boolean): boolean {
  return !isPremiumTheme(theme) || premiumAllowed;
}
