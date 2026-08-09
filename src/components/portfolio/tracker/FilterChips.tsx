'use client';

export interface FilterChip {
  key: string;
  label: string;
  /** Optional count shown after the label; omitted rather than rendered as 0. */
  count?: number | null;
}

/**
 * The one horizontal chip rail, shared by both views and by the detail screen.
 *
 * It is a tablist because that is what it is: one of the chips is always
 * selected and selecting another changes what the panel below shows. Arrow-key
 * roving is left to the browser's normal tab order rather than hand-rolled —
 * every chip is reachable, which is the part that matters, and a wrong roving
 * implementation is worse than none.
 *
 * `overflow-x-auto` on the rail with `min-w-0` above it is what keeps a long
 * list of categories from widening the page on a 320px handset.
 */
export function FilterChips({ items, value, onChange, label, className = '' }: {
  items: FilterChip[];
  value: string;
  onChange: (key: string) => void;
  label: string;
  className?: string;
}) {
  if (items.length === 0) return null;
  return <div
    role="tablist"
    aria-label={label}
    className={`-mx-3 flex min-w-0 gap-2 overflow-x-auto px-3 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden ${className}`}
  >
    {items.map((item) => {
      const selected = item.key === value;
      return <button
        key={item.key}
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => onChange(item.key)}
        className={`flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-semibold transition-colors ${selected
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'}`}
      >
        {item.label}
        {typeof item.count === 'number' && item.count > 0 && <span
          aria-hidden="true"
          className={`rounded-full px-1.5 text-xs font-bold ${selected ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--surface-hover)] text-[var(--text-muted)]'}`}
        >{item.count}</span>}
      </button>;
    })}
  </div>;
}
