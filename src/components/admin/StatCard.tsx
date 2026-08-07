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

/**
 * `hero` is for the one figure a group is *about* — it earns its size by being
 * the only one, so there is at most one per group. It carries the accent surface
 * rather than a bigger shadow or a second border weight, because the two
 * coloured tones already mean "go and look" and a third emphasis in the same
 * language would compete with them.
 */
export type StatEmphasis = 'default' | 'hero';

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
  emphasis = 'default',
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: StatTone;
  emphasis?: StatEmphasis;
}) {
  const hero = emphasis === 'hero';
  return (
    /*
      A column, so the hint can be pushed to the bottom edge: grid rows stretch
      every card to the tallest in the row, and without this the cards that carry
      a hint sit their figure at a different height from the ones that do not.
    */
    <div
      className={`flex min-w-0 flex-col rounded-2xl border p-3 shadow-[var(--shadow)] sm:p-4 ${
        hero
          ? 'border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[var(--accent-soft)]'
          : `${TONE_CLASS[tone]} bg-[var(--surface)]`
      }`}
    >
      <p className={`truncate text-xs ${hero ? 'font-medium text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
        {label}
      </p>
      {/*
        `tabular-nums` so a column of figures does not jitter as it refreshes, and
        `break-all` so a long baht figure wraps inside a 320px card instead of
        widening the grid and giving the whole page a horizontal scrollbar.
      */}
      <p
        className={`mt-1 font-semibold tabular-nums break-all ${
          hero ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'
        } ${VALUE_CLASS[tone]}`}
      >
        {value}
      </p>
      {hint && <p className="mt-auto pt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
