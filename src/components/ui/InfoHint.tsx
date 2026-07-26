'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { getGlossaryTerm, type GlossaryTermId } from '@/src/lib/analytics/glossary';

/**
 * A small, accessible info affordance that explains a beginner-confusing metric
 * using the shared {@link getGlossaryTerm glossary} (items 4–10).
 *
 * - Desktop: hover **or** keyboard focus opens the explanation.
 * - Touch: tapping the icon toggles it; tapping outside or the close button
 *   dismisses it.
 * - Escape closes; the trigger is keyboard focusable with an ARIA label and is
 *   described by the popover while open.
 * - Motion is limited to `motion-safe` so reduced-motion users get no animation.
 *
 * The visible icon is intentionally small to keep the panel compact, but its tap
 * target is expanded to ≥44px via a transparent pseudo-element (item 23).
 */
export function InfoHint({
  term,
  align = 'start',
  className,
}: {
  term: GlossaryTermId;
  /** Which edge of the trigger the popover aligns to. */
  align?: 'start' | 'end';
  className?: string;
}) {
  const entry = getGlossaryTerm(term);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={`relative inline-flex shrink-0 self-center align-middle ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {/*
        A fixed, non-shrinking circle: `flex-none` (flex: 0 0 auto), `aspect-square`
        and an explicit 24px block/inline size stop a tight parent grid/flex from
        squeezing it into a vertical pill. The ≥44px touch target is an absolutely
        positioned transparent `::after` that never affects layout size.
      */}
      <button
        type="button"
        aria-label={`คำอธิบาย: ${entry.label}`}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ inlineSize: 18, blockSize: 18, aspectRatio: '1' }}
        className="relative box-border inline-flex flex-none shrink-0 grow-0 items-center justify-center self-center rounded-full text-[15px] leading-none text-slate-500 outline-none after:absolute after:-inset-[13px] after:content-[''] hover:text-[#D4FF00] focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <span
          id={popId}
          role="dialog"
          aria-label={`คำอธิบาย ${entry.label}`}
          className={`absolute top-full z-50 mt-1 block w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-700 bg-[#0F1420] p-3 text-left shadow-xl motion-safe:transition-opacity ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          <span className="flex items-start justify-between gap-2">
            <b className="text-xs font-semibold text-white">{entry.label}</b>
            <button
              type="button"
              aria-label="ปิดคำอธิบาย"
              onClick={() => setOpen(false)}
              className="-m-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </span>
          <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
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
        </span>
      )}
    </span>
  );
}

export default InfoHint;
