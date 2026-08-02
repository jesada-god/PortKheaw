'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DetailPopoverProps {
  /** Accessible name of the trigger, e.g. "ดูรายละเอียดแนวรับ S1". */
  triggerLabel: string;
  /** Heading rendered inside the panel; also its accessible name. */
  title: ReactNode;
  /** Accessible name of the panel when the visible title is decorated markup. */
  dialogLabel?: string;
  children: ReactNode;
  /** Which edge of the trigger the desktop popover aligns to. */
  align?: 'start' | 'end';
  testId?: string;
}

/**
 * The one info affordance used below the chart.
 *
 * A small ⓘ trigger — never a large "?" button — opens a compact popover
 * anchored to the icon on desktop and a content-height bottom sheet on mobile.
 * Escape closes it and returns focus to the trigger, so provenance and
 * methodology detail can live here instead of cluttering the primary UI.
 */
export function DetailPopover({
  triggerLabel,
  title,
  dialogLabel,
  children,
  align = 'end',
  testId,
}: DetailPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <span className="relative inline-flex shrink-0 self-center align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid={testId}
        style={{ inlineSize: 18, blockSize: 18, aspectRatio: '1' }}
        className="relative box-border inline-flex flex-none items-center justify-center rounded-full text-[15px] leading-none text-slate-500 outline-none after:absolute after:-inset-[13px] after:content-[''] hover:text-[#D4FF00] focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <>
          {/* Mobile: a dismiss layer behind the content-height sheet. The sheet
              itself stops above the dock rather than at the viewport edge,
              where the capsule would sit over its last rows. */}
          <button type="button" aria-label="ปิดรายละเอียด" onClick={close} className="fixed inset-0 z-40 bg-black/50 sm:hidden" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={dialogLabel ?? (typeof title === 'string' ? title : triggerLabel)}
            className={`fixed inset-x-3 bottom-[var(--dock-clearance)] z-50 max-h-[70vh] overflow-y-auto overscroll-contain rounded-xl border border-slate-700 bg-[#0F1420] p-3 text-left shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-7 sm:w-80 sm:max-w-[calc(100vw-2rem)] ${align === 'end' ? 'sm:right-0' : 'sm:left-0'}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
              <b className="min-w-0 text-sm text-slate-100">{title}</b>
              <button
                ref={closeRef}
                type="button"
                aria-label="ปิดรายละเอียด"
                onClick={close}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 outline-none hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            {children}
          </div>
        </>
      )}
    </span>
  );
}

export default DetailPopover;
