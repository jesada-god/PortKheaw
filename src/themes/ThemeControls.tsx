'use client';

import { Check, Laptop, Moon, Sun } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { getTheme } from './registry';
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

export function ThemeControls() {
  const { theme, appearance, resolvedAppearance, setAppearance } = useTheme();
  const definition = getTheme(theme);

  return (
    <div className="space-y-6" data-testid="theme-controls">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium text-[var(--text)]">ธีม</p>
          <p className="text-xs text-[var(--text-muted)]">{definition.description}</p>
        </div>
        <div className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 text-sm font-semibold text-[var(--text)]">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
          {definition.label}
        </div>
      </div>

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
