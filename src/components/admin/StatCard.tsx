import type { ReactNode } from 'react';

/**
 * One number, said plainly.
 *
 * The dashboard is a grid of these rather than a page of charts on purpose: an
 * operator opening it at 09:00 is asking "is anything wrong, and how many?", and
 * a sparkline answers neither question faster than a figure does. Charts are
 * worth their space where a *shape* carries meaning; a count of dead-lettered
 * webhooks has no shape worth drawing.
 *
 * `tone` marks the two cards that mean "go and look" — nothing else is coloured,
 * so the two that are cannot be missed.
 */
export type StatTone = 'neutral' | 'attention' | 'critical';

const TONE_CLASS: Readonly<Record<StatTone, string>> = {
  neutral: 'border-[var(--border)]',
  attention: 'border-[color-mix(in_srgb,var(--warning,var(--text-muted))_50%,var(--border))]',
  critical: 'border-[color-mix(in_srgb,var(--negative)_45%,var(--border))]',
};

const VALUE_CLASS: Readonly<Record<StatTone, string>> = {
  neutral: 'text-[var(--text)]',
  attention: 'text-[var(--text)]',
  critical: 'text-[var(--negative)]',
};

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <div
      className={`min-w-0 rounded-2xl border ${TONE_CLASS[tone]} bg-[var(--surface)] p-3 shadow-[var(--shadow)] sm:p-4`}
    >
      <p className="truncate text-xs text-[var(--text-muted)]">{label}</p>
      {/*
        `tabular-nums` so a column of figures does not jitter as it refreshes, and
        `break-all` so a long baht figure wraps inside a 320px card instead of
        widening the grid and giving the whole page a horizontal scrollbar.
      */}
      <p className={`mt-1 text-xl font-semibold tabular-nums break-all sm:text-2xl ${VALUE_CLASS[tone]}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
