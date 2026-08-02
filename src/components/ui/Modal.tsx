'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { useDialogA11y } from '@/src/hooks/useDialogA11y';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  closeDisabled?: boolean;
}

const subscribeToHydration = () => () => undefined;

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  className,
  initialFocusRef,
  closeDisabled = false,
}: ModalProps) {
  const titleId = React.useId();
  const close = React.useCallback(() => {
    if (!closeDisabled) onClose();
  }, [closeDisabled, onClose]);
  const dialogRef = useDialogA11y(isOpen, close, initialFocusRef);
  const mounted = React.useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  if (!mounted || !isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex h-[100dvh] max-h-[100dvh] items-end justify-center overflow-hidden bg-[var(--overlay)] backdrop-blur-sm sm:items-center sm:p-4"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      data-testid="modal-backdrop"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'flex max-h-[100dvh] w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl',
          className,
        )}
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2 sm:px-6">
          <h2 id={titleId} className="min-w-0 break-words text-lg font-semibold text-[var(--text)] [overflow-wrap:anywhere]">{title}</h2>
          <button
            type="button"
            onClick={close}
            disabled={closeDisabled}
            aria-label="ปิดหน้าต่าง"
            className="flex min-h-11 min-w-11 flex-none items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain break-words p-4 [overflow-wrap:anywhere] sm:p-6"
          data-testid="modal-body"
        >
          {children}
        </div>
        {footer && (
          <div
            className="sticky bottom-0 z-10 box-border shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-4"
            data-testid="modal-footer"
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
