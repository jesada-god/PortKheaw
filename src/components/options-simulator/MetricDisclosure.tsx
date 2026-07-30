'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';

/**
 * A collapsed-by-default explanation attached to one metric card or one
 * technical block.
 *
 * The simulator used to print a metric's `helper` text unconditionally next to
 * a hover-only ⓘ icon, so every explanation was already on screen before the
 * reader pressed anything — the icon promised a disclosure that did not exist.
 * This component is the disclosure: the body is rendered but `hidden` until the
 * trigger is pressed.
 *
 * Each instance owns its own `open` state and its own `useId()`-derived ids, so
 * a page full of metric cards can never share one boolean: opening one card
 * leaves every other card closed.
 *
 * Accessibility contract:
 *  - the trigger is a real `<button>`, so Enter/Space toggle it for free;
 *  - `aria-expanded` tracks the state and `aria-controls` always resolves,
 *    because the panel stays in the DOM and toggles `hidden`;
 *  - the panel is a labelled region pointing back at its trigger;
 *  - `focus-visible` draws the shared accent ring.
 */
export function MetricDisclosure({
  summary,
  openSummary,
  label,
  icon = 'help',
  className,
  triggerClassName,
  panelClassName,
  children,
}: {
  summary: string;
  /** Trigger text once open. Defaults to `summary` when the label should not change. */
  openSummary?: string;
  /** Appended to the accessible name so screen readers hear which metric this explains. */
  label?: string;
  icon?: 'help' | 'chevron';
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const controlId = useId();
  const panelId = `${controlId}-panel`;
  const [open, setOpen] = useState(false);
  const Icon = icon === 'chevron' ? ChevronDown : HelpCircle;
  return (
    <div className={className}>
      <button
        type="button"
        id={controlId}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="metric-disclosure-toggle"
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex min-h-9 cursor-pointer items-center gap-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-[#D4FF00] ${triggerClassName ?? 'text-xs font-semibold text-[#D4FF00]'}`}
      >
        <Icon size={12} aria-hidden="true" className={icon === 'chevron' && open ? 'rotate-180' : undefined} />
        {open ? openSummary ?? summary : summary}
        {label && <span className="sr-only"> · {label}</span>}
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={controlId}
        hidden={!open}
        data-testid="metric-disclosure-panel"
        className={panelClassName ?? 'mt-1 text-xs leading-relaxed text-slate-400'}
      >
        {children}
      </div>
    </div>
  );
}

export default MetricDisclosure;
