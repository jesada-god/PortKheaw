'use client';

import { useState } from 'react';
import { Check, ChevronRight, Laptop, Lock, Moon, Sun } from 'lucide-react';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { PLAN_DISPLAY_NAME, upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { cn } from '@/src/utils/cn';
import { getTheme, themeDefinitions } from './registry';
import { useTheme } from './ThemeProvider';
import type { Appearance, ThemeId } from './types';

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

/**
 * The three colours that describe a theme, published by that theme's own
 * palette file. The picker previews a theme it is not currently wearing without
 * holding a copy of anyone's palette.
 */
function ThemeSwatch({ theme, className }: { theme: ThemeId; className?: string }) {
  return (
    <span
      data-theme-swatch={theme}
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center rounded-full border border-[var(--border-strong)] p-0.5',
        className,
      )}
    >
      <span className="size-4 rounded-full bg-[var(--swatch-bg)]" />
      <span className="-ml-1 size-4 rounded-full bg-[var(--swatch-surface)]" />
      <span className="-ml-1 size-4 rounded-full bg-[var(--swatch-accent)]" />
    </span>
  );
}

export function ThemeControls() {
  const { theme, appearance, resolvedAppearance, premiumThemesAllowed, setTheme, setAppearance } = useTheme();
  const { requestUpgrade } = useEntitlement();
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = getTheme(theme);

  /*
   * A locked row closes the sheet before asking for the upgrade. The prompt is
   * the shared `UpgradeModal`, which is a dialog of its own — two open at once
   * would put two focus traps on the same Tab key.
   */
  const choose = (id: ThemeId, locked: boolean) => {
    setPickerOpen(false);
    if (locked) {
      requestUpgrade({ capability: 'theme.premium', source: 'settings.theme' });
      return;
    }
    setTheme(id);
  };

  return (
    <div className="space-y-6" data-testid="theme-controls">
      {/*
        One row, the same shape as the other settings rows: what the setting is,
        what it is currently set to, and a chevron saying there is more behind
        it. The choices themselves live in the sheet, so the display section no
        longer opens with a wall of cards.
      */}
      <button
        type="button"
        data-testid="theme-row"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen(true)}
        className="flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
      >
        <ThemeSwatch theme={current.id} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-[var(--text)]">ธีมสี</span>
          <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{current.label}</span>
        </span>
        <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
      </button>

      <ResponsiveDialog isOpen={pickerOpen} onClose={() => setPickerOpen(false)} title="ธีมสี">
        <div className="space-y-2">
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
                onClick={() => choose(definition.id, locked)}
                className={cn(
                  'flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color]',
                  selected && !locked
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                )}
              >
                <ThemeSwatch theme={definition.id} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--text)]">{definition.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--text-muted)]">
                    {definition.description}
                  </span>
                </span>
                {locked
                  ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]">
                      <Lock aria-hidden="true" size={11} />
                      {PREMIUM_THEME_PLAN}
                    </span>
                  )
                  : selected && <Check aria-hidden="true" size={18} className="shrink-0 text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
        {!premiumThemesAllowed && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            ธีมสีพิเศษใช้ได้ในแพ็กเกจ {PREMIUM_THEME_PLAN} ขึ้นไป
          </p>
        )}
      </ResponsiveDialog>

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
