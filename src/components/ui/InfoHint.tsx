'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getGlossaryTerm, type GlossaryTermId } from '@/src/lib/analytics/glossary';

/**
 * A small, accessible info affordance that explains a beginner-confusing metric
 * using the shared {@link getGlossaryTerm glossary}.
 *
 * Two presentations, one behaviour:
 *
 *  - **Desktop (≥640px)** — a compact popover anchored to the trigger. Hover or
 *    activating the focused button opens it.
 *  - **Mobile (<640px)** — a bottom sheet sized to its CONTENT (`max-h` with
 *    internal scrolling), not to the viewport, so a two-line explanation does
 *    not cover the whole screen. A scrim sits behind it.
 *
 * Accessibility contract, identical in both presentations:
 *  - the trigger is a real `<button>` with a Thai `aria-label` and `aria-expanded`;
 *  - Escape closes, and focus RETURNS to the trigger that opened it;
 *  - a pointer press outside closes;
 *  - the icon stays visually 18px while its tap target is expanded to ≥44px by a
 *    transparent pseudo-element that never affects layout;
 *  - motion is limited to `motion-safe`.
 *
 * The breakpoint is resolved with `matchMedia` rather than CSS alone because the
 * two presentations need genuinely different DOM (a scrim, a different dismiss
 * surface), not just different styling.
 */

const MOBILE_QUERY = '(max-width: 639px)';

function useIsCompactViewport(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return compact;
}

export function InfoHint({
  term,
  align = 'start',
  className,
}: {
  term: GlossaryTermId;
  /** Which edge of the trigger the desktop popover aligns to. */
  align?: 'start' | 'end';
  className?: string;
}) {
  const entry = getGlossaryTerm(term);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const compact = useIsCompactViewport();

  /** Closing always hands focus back to the control that opened the panel. */
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    /*
      Escape is claimed in the CAPTURE phase and stopped there. An enclosing
      dialog (ResponsiveDialog/useDialogA11y) also closes on a document-level
      Escape, so without this an open hint inside a dialog would dismiss both at
      once — the reader would lose the panel they were reading about.
    */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  const body = (
    <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed sm:text-[11px]">
      <div>
        <dt className="font-semibold text-[#D4FF00]">คืออะไร</dt>
        <dd className="text-slate-300">{entry.what}</dd>
      </div>
      <div>
        <dt className="font-semibold text-[#D4FF00]">มีไว้ทำไม</dt>
        <dd className="text-slate-300">{entry.why}</dd>
      </div>
      <div>
        <dt className="font-semibold text-[#D4FF00]">ใช้ดูตอนไหน</dt>
        <dd className="text-slate-300">{entry.when}</dd>
      </div>
    </dl>
  );

  const heading = (
    <span className="flex items-start justify-between gap-2">
      <b className="text-xs font-semibold text-white">{entry.label}</b>
      <button
        type="button"
        aria-label="ปิดคำอธิบาย"
        onClick={() => close()}
        className="-m-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-slate-500 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </span>
  );

  return (
    <span
      ref={wrapRef}
      className={`relative inline-flex shrink-0 self-center align-middle ${className ?? ''}`}
      // Hover-to-open is a desktop-only affordance; on touch it would fight the
      // tap that toggles the sheet. Keyboard users open the real button with
      // Enter/Space. Deliberately do not open on focus: closing with Escape must
      // be able to restore focus to this trigger without reopening the dialog.
      onMouseEnter={() => { if (!compact) setOpen(true); }}
      onMouseLeave={() => { if (!compact) setOpen(false); }}
    >
      {/*
        A fixed, non-shrinking circle: `flex-none` (flex: 0 0 auto), `aspect-square`
        and an explicit 18px block/inline size stop a tight parent grid/flex from
        squeezing it into a vertical pill. The ≥44px touch target is an absolutely
        positioned transparent `::after` that never affects layout size.

        `min-h-0` is what makes the sentence above TRUE, and it was missing.
        `globals.css` gives every `button` a `min-height: 44px` so that a control
        nobody sized is still tappable — and `min-height` beats `height`, so this
        icon was an 18px circle inside a 44px box in every layout it appeared in,
        with the ::after insetting from THAT (a 44x70 target, not 44x44).

        Measured, not reasoned about: at 1280, 380 and 320px the Confidence label
        row of the Options Signal header was 44px tall against a 13.75px line,
        which put its label 15.1px and its number 30.3px below the score's. The
        icon carries its own target, so the floor here is not what makes it
        reachable and it can go.
      */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={`คำอธิบาย: ${entry.label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-describedby={open ? popId : undefined}
        data-testid={`info-hint-${term}`}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ inlineSize: 18, blockSize: 18, aspectRatio: '1' }}
        className="relative box-border inline-flex min-h-0 flex-none shrink-0 grow-0 items-center justify-center self-center rounded-full text-[15px] leading-none text-slate-500 outline-none after:absolute after:-inset-[13px] after:content-[''] hover:text-[#D4FF00] focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
      >
        <span aria-hidden="true">ⓘ</span>
      </button>

      {open && compact && (
        <>
          {/* Scrim. Tapping it dismisses without stealing focus back mid-gesture. */}
          <span
            aria-hidden="true"
            onClick={() => close()}
            className="fixed inset-0 z-[100] block bg-black/60 motion-safe:transition-opacity"
          />
          <span
            id={popId}
            role="dialog"
            aria-modal="true"
            aria-label={`คำอธิบาย ${entry.label}`}
            data-testid={`info-sheet-${term}`}
            // Height follows the content and only scrolls once it would take
            // over the screen — never a full-height sheet for two short lines.
            className="fixed inset-x-0 bottom-0 z-[101] block max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-[#0F1420] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-left shadow-2xl motion-safe:transition-transform"
          >
            <span aria-hidden="true" className="mx-auto mb-3 block h-1 w-10 rounded-full bg-slate-700" />
            {heading}
            {body}
          </span>
        </>
      )}

      {open && !compact && (
        <span
          id={popId}
          role="dialog"
          aria-label={`คำอธิบาย ${entry.label}`}
          data-testid={`info-popover-${term}`}
          className={`absolute top-full z-50 mt-1 block w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-700 bg-[#0F1420] p-3 text-left shadow-xl motion-safe:transition-opacity ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {heading}
          {body}
        </span>
      )}
    </span>
  );
}

export default InfoHint;
