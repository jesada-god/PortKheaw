import type { StatusTone } from '@/src/lib/support/presentation';

/**
 * One chip, five tones, theme tokens only.
 *
 * The tones are deliberately not the gain/loss colours the market surfaces use.
 * A refund that was rejected is not a "loss" and a resolved ticket is not a
 * "gain"; borrowing those two colours here would make a page of neutral
 * administrative states read like a portfolio.
 */
const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'border-[var(--border)] bg-[var(--surface-hover)] text-[var(--text-muted)]',
  active: 'border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]',
  waiting: 'border-[var(--border-strong)] bg-transparent text-[var(--text)]',
  positive: 'border-transparent bg-[color-mix(in_srgb,var(--positive)_14%,transparent)] text-[var(--positive)]',
  negative: 'border-transparent bg-[color-mix(in_srgb,var(--negative)_14%,transparent)] text-[var(--negative)]',
};

export function StatusChip({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
