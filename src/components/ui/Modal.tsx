'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { useDialogA11y } from '@/src/hooks/useDialogA11y';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export function Modal({ isOpen, onClose, title, children, className, initialFocusRef }: ModalProps) {
  const titleId = React.useId();
  const dialogRef = useDialogA11y(isOpen, onClose, initialFocusRef);
  if (!isOpen) return null;

  return <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
    <div className="fixed inset-0 bg-[var(--overlay)] backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={cn(
        'keyboard-safe-modal relative z-50 max-h-dvh w-full min-w-0 max-w-lg overflow-x-hidden overflow-y-auto overscroll-contain break-words rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[var(--shadow)] outline-none [overflow-wrap:anywhere] sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:p-6',
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={titleId} className="min-w-0 text-lg font-semibold text-[var(--text)]">{title}</h2>
        <button type="button" onClick={onClose} aria-label="ปิดหน้าต่าง" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)]">
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  </div>;
}
