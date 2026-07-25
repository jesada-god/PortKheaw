'use client';

import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogA11y } from '@/src/hooks/useDialogA11y';

interface ResponsiveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  labelledBy?: string;
}

/**
 * Viewport-owned dialog shared by data-source and explanation surfaces.
 *
 * The portal is deliberately absent from both the server render and the first
 * client render. It can only appear after hydration and an explicit open state,
 * so SSR markup stays deterministic while the overlay escapes card clipping.
 */
export function ResponsiveDialog({
  isOpen,
  onClose,
  title,
  children,
  labelledBy,
}: ResponsiveDialogProps) {
  const generatedTitleId = `dialog-title-${useId().replaceAll(':', '')}`;
  const titleId = labelledBy ?? generatedTitleId;
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogA11y(isOpen, onClose, closeRef);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center overflow-hidden bg-black/70 p-3 sm:items-center"
      style={{
        paddingTop: 'max(12px, env(safe-area-inset-top))',
        paddingRight: 'max(12px, env(safe-area-inset-right))',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(12px, env(safe-area-inset-left))',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="dialog-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[35rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#0F1420] shadow-2xl"
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2">
          <h2 id={titleId} className="min-w-0 break-words font-bold text-white [overflow-wrap:anywhere]">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="ปิดหน้าต่าง"
            onClick={onClose}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4 break-words [overflow-wrap:anywhere]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
