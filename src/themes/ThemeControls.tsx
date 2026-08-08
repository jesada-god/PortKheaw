'use client';

import { Check, Laptop, Lock, Moon, Sun } from 'lucide-react';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { PLAN_DISPLAY_NAME, upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { cn } from '@/src/utils/cn';
import { themeDefinitions } from './registry';
import { useTheme } from './ThemeProvider';
import type { Appearance } from './types';

const appearances: Array<{
  value: Appearance;
  label: string;
  description: string;
  icon: typeof Laptop;
}> = [
  {
    value: 'system',
    label: 'ตามระบบ',
    description: 'เปลี่ยนโหมดสว่างหรือมืดตามการตั้งค่าของอุปกรณ์',
    icon: Laptop,
  },
  {
    value: 'light',
    label: 'สว่าง',
    description: 'ใช้พื้นหลังสว่างตลอดเวลา',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'มืด',
    description: 'ใช้พื้นหลังมืดตลอดเวลา',
    icon: Moon,
  },
];

/** The plan the paid themes ask for, read from the entitlement matrix. */
const PREMIUM_THEME_PLAN = PLAN_DISPLAY_NAME[upgradeTargetTier('theme.premium')];

export function ThemeControls() {
  const { theme, appearance, resolvedAppearance, premiumThemesAllowed, setTheme, setAppearance } = useTheme();
  const { requestUpgrade } = useEntitlement();

  return (
    <div className="space-y-6" data-testid="theme-controls">
      <fieldset className="space-y-3">
        <legend className="font-medium text-[var(--text)]">ธีมสี</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {themeDefinitions.map((definition) => {
            const selected = theme === definition.id;
            const locked = definition.premium && !premiumThemesAllowed;
            return (
              <button
                key={definition.id}
                type="button"
                aria-pressed={locked ? undefined : selected}
                data-testid={`theme-option-${definition.id}`}
                data-locked={locked ? 'true' : undefined}
                aria-label={locked
                  ? `${definition.label} — ต้องใช้แพ็กเกจ ${PREMIUM_THEME_PLAN} ขึ้นไป`
                  : definition.label}
                onClick={() => (locked
                  ? requestUpgrade({ capability: 'theme.premium', source: 'settings.theme' })
                  : setTheme(definition.id))}
                className={cn(
                  'relative min-h-32 rounded-xl border p-4 text-left transition-[background-color,border-color,color] duration-200',
                  selected && !locked
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  {/* The three colours that describe the theme, published by its
                      own palette file — the picker never holds a copy. */}
                  <span
                    data-theme-swatch={definition.id}
                    aria-hidden="true"
                    className="flex items-center rounded-full border border-[var(--border-strong)] p-0.5"
                  >
                    <span className="size-4 rounded-full bg-[var(--swatch-bg)]" />
                    <span className="-ml-1 size-4 rounded-full bg-[var(--swatch-surface)]" />
                    <span className="-ml-1 size-4 rounded-full bg-[var(--swatch-accent)]" />
                  </span>
                  {locked
                    ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">
                        <Lock aria-hidden="true" size={11} />
                        {PREMIUM_THEME_PLAN}
                      </span>
                    )
                    : selected && <Check aria-hidden="true" size={18} className="text-[var(--accent)]" />}
                </span>
                <span className="mt-3 block text-sm font-semibold text-[var(--text)]">{definition.label}</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                  {definition.description}
                </span>
              </button>
            );
          })}
        </div>
        {!premiumThemesAllowed && (
          <p className="text-xs text-[var(--text-muted)]">
            ธีมสีพิเศษใช้ได้ในแพ็กเกจ {PREMIUM_THEME_PLAN} ขึ้นไป
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-medium text-[var(--text)]">โหมดการแสดงผล</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {appearances.map(({ value, label, description, icon: Icon }) => {
            const selected = appearance === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setAppearance(value)}
                className={cn(
                  'relative min-h-32 rounded-xl border p-4 text-left transition-[background-color,border-color,color] duration-200',
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                )}
              >
                <span className="flex items-center justify-between">
                  <Icon aria-hidden="true" size={20} className={selected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'} />
                  {selected && <Check aria-hidden="true" size={18} className="text-[var(--accent)]" />}
                </span>
                <span className="mt-3 block text-sm font-semibold text-[var(--text)]">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">{description}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
          กำลังแสดงผลแบบ{resolvedAppearance === 'dark' ? 'มืด' : 'สว่าง'}
        </p>
      </fieldset>
    </div>
  );
}
