'use client';

export type TrackerView = 'assets' | 'portfolios';

/**
 * The screen's primary question: am I looking at what I own, or at where I keep
 * it? Both answers are drawn from the same summaries — the toggle changes how
 * they are grouped and nothing else.
 */
export function ViewToggle({ value, onChange }: {
  value: TrackerView;
  onChange: (value: TrackerView) => void;
}) {
  return <div
    role="tablist"
    aria-label="มุมมองสินทรัพย์"
    className="flex min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-1"
    data-testid="tracker-view-toggle"
  >
    {([
      ['assets', 'แยกสินทรัพย์'],
      ['portfolios', 'แยกพอร์ต'],
    ] as const).map(([key, label]) => <button
      key={key}
      type="button"
      role="tab"
      aria-selected={value === key}
      onClick={() => onChange(key)}
      className={`min-h-10 min-w-0 flex-1 truncate rounded-lg px-3 text-sm font-bold transition-colors ${value === key
        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
        : 'text-[var(--text-secondary)] hover:text-[var(--text)]'}`}
    >{label}</button>)}
  </div>;
}
