'use client';

import * as React from 'react';
import { useId } from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '@/src/hooks/useDialogA11y';
import { cn } from '@/src/utils/cn';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
  variant?: 'drawer' | 'responsive-dialog';
}

export function Drawer({
  isOpen,
  onClose,
  title,
  children,
  className,
  id,
  variant = 'drawer',
}: DrawerProps) {
  const titleId = useId();
  const dialogRef = useDialogA11y(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className={cn(
      'fixed inset-0 z-50 flex items-end',
      variant === 'responsive-dialog'
        ? 'sm:items-center sm:justify-center sm:p-6'
        : 'sm:items-stretch sm:justify-end',
    )}>
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        id={id}
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          'relative z-50 flex w-full min-w-0 flex-col overflow-hidden bg-[#151B28] shadow-2xl outline-none',
          variant === 'responsive-dialog'
            ? 'h-[min(90dvh,52rem)] max-h-[90dvh] rounded-t-2xl border border-slate-800 animate-in slide-in-from-bottom duration-300 sm:h-[min(86dvh,52rem)] sm:max-w-3xl sm:rounded-2xl sm:zoom-in-95'
            : 'h-[min(85dvh,48rem)] rounded-t-2xl border-t border-slate-800 animate-in slide-in-from-bottom duration-300 sm:h-full sm:max-w-md sm:rounded-none sm:border-l sm:border-t-0 sm:slide-in-from-right-full',
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 sm:py-4">
          <h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดแผง"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
          >
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}
